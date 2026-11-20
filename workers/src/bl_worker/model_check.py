"""The model check (decisions.md, "the run record: the model check").

A lab member presses "Check with models" on a built task folder, which makes one waiting
`task_model_runs` row per model. This job sends each model the de-identified task (the
question, the context, the protocol as run and the scrubbed evidence text), never the answer
key, the rubric or the review notes. A grader model then judges each answer against the
confirmed cause; partial and unclear answers wait for a second scientist on the page.

`assert_exportable(task)` runs before every call that leaves Binary, the grader's too, and a
refusal stops the check before anything is sent. A check never spends past the cost cap stored
on its rows: before each call it adds that call's worst case to what's spent.

The worker's environment is the only place keys live. It publishes what it can run to
`model_check_setup`, so the page says what to add instead of the web app holding keys.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import math
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Literal, Protocol
from uuid import UUID

import httpx
import psycopg
from procrastinate import App, JobContext, RetryStrategy
from procrastinate.exceptions import AlreadyEnqueued
from pydantic import BaseModel, SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from bl_worker.config import WORKERS_DIR
from bl_worker.previews import PreviewStore

if TYPE_CHECKING:
    from bl_worker.runtime import Runtime

log = logging.getLogger(__name__)

# OpenRouter's names. One config value, MODEL_CHECK_MODELS, replaces the list.
DEFAULT_MODELS = (
    "anthropic/claude-opus-5.5",
    "openai/gpt-6.2-astra",
    "google/gemini-4-neon",
    "x-ai/grok-4.7",
)
DEFAULT_GRADER = "anthropic/claude-sonnet-5.5"

# Dollars per million tokens (input, output), from OpenRouter's model list on 2026-11-20. A
# model without a price here is never run: its worst case can't be held to the cap.
PRICES: dict[str, tuple[Decimal, Decimal]] = {
    "anthropic/claude-opus-5.5": (Decimal("4"), Decimal("20")),
    "anthropic/claude-sonnet-5.5": (Decimal("2"), Decimal("10")),
    "anthropic/claude-fable-5.2": (Decimal("8"), Decimal("40")),
    "openai/gpt-6.2-astra": (Decimal("8"), Decimal("40")),
    "google/gemini-4-neon": (Decimal("3"), Decimal("15")),
    "x-ai/grok-4.7": (Decimal("2"), Decimal("6")),
}

# Reasoning counts against the output ceiling. Every default model supports these efforts.
SOLVER_MAX_TOKENS = 8000
SOLVER_EFFORT = "high"
GRADER_MAX_TOKENS = 2000
GRADER_EFFORT = "medium"
# A task longer than this isn't sent rather than cut: a cut task is a different task.
MAX_PROMPT_CHARS = 80_000
# The folder is read whole to find its text; a bigger one (mostly images) isn't opened.
MAX_ZIP_BYTES = 200 * 1024 * 1024
# The worst case per token of text: English runs near 4 characters a token, tables of numbers
# nearer 2. The ceiling assumes 2.
CHARS_PER_TOKEN = 2
# The question and the confirmed cause are each at most 4000 characters (0034).
MAX_QUESTION_CHARS = 4000
MAX_CAUSE_CHARS = 4000


class CheckSettings(BaseSettings):
    """The model check's part of the worker's environment, read beside Settings."""

    model_config = SettingsConfigDict(
        env_file=WORKERS_DIR / ".env", env_ignore_empty=True, extra="ignore", frozen=True
    )

    openrouter_api_key: SecretStr | None = None
    anthropic_api_key: SecretStr | None = None
    openai_api_key: SecretStr | None = None
    gemini_api_key: SecretStr | None = None
    xai_api_key: SecretStr | None = None
    model_check_models: str = ",".join(DEFAULT_MODELS)
    model_check_grader: str = DEFAULT_GRADER
    model_check_cost_cap_usd: Decimal = Decimal("2.00")


Via = Literal["openrouter", "anthropic", "openai", "google", "x-ai"]

# Each provider's own key, when there is no OpenRouter key: the environment variable, and the
# OpenAI-compatible address (None for Anthropic, which goes through its own SDK).
DIRECT: dict[str, tuple[str, str | None]] = {
    "anthropic": ("anthropic_api_key", None),
    "openai": ("openai_api_key", "https://api.openai.com/v1"),
    "google": ("gemini_api_key", "https://generativelanguage.googleapis.com/v1beta/openai"),
    "x-ai": ("xai_api_key", "https://api.x.ai/v1"),
}
OPENROUTER_URL = "https://openrouter.ai/api/v1"


@dataclass(frozen=True)
class Route:
    """How one model is reached: its OpenRouter name, which door, and that door's key."""

    model: str
    via: Via
    key: SecretStr

    @property
    def provider_model(self) -> str:
        """The name the door itself takes: OpenRouter's as is, a provider's own without the
        provider in front (and Anthropic's with dashes for dots)."""
        if self.via == "openrouter":
            return self.model
        name = self.model.split("/", 1)[1]
        return name.replace(".", "-") if self.via == "anthropic" else name


@dataclass(frozen=True)
class Setup:
    routes: dict[str, Route]
    # (model, what to add) for each configured model that can't run.
    unreachable: tuple[tuple[str, str], ...]
    grader: Route | None
    cost_cap_usd: Decimal
    # The keys to add when nothing can run.
    missing: tuple[str, ...]

    @property
    def ready(self) -> bool:
        return bool(self.routes) and self.grader is not None


def route_for(model: str, s: CheckSettings) -> Route | str:
    """The route, or what to add to reach it."""
    if model not in PRICES:
        return "a price in model_check.PRICES"
    if s.openrouter_api_key is not None:
        return Route(model, "openrouter", s.openrouter_api_key)
    provider = model.split("/", 1)[0]
    direct = DIRECT.get(provider)
    key = getattr(s, direct[0]) if direct else None
    if direct is None or key is None:
        return "OPENROUTER_API_KEY" + (f" or {direct[0].upper()}" if direct else "")
    return Route(model, provider, key)  # type: ignore[arg-type]


def setup_from(s: CheckSettings) -> Setup:
    models = [m.strip() for m in s.model_check_models.split(",") if m.strip()]
    routes: dict[str, Route] = {}
    unreachable: list[tuple[str, str]] = []
    for model in dict.fromkeys(models):
        r = route_for(model, s)
        if isinstance(r, Route):
            routes[model] = r
        else:
            unreachable.append((model, r))
    grader = route_for(s.model_check_grader, s)
    missing: list[str] = []
    if not routes or not isinstance(grader, Route):
        missing.append("OPENROUTER_API_KEY")
    return Setup(
        routes,
        tuple(unreachable),
        grader if isinstance(grader, Route) else None,
        s.model_check_cost_cap_usd,
        tuple(missing),
    )


# ---- What is sent.


@dataclass(frozen=True)
class Ask:
    system: str
    user: str
    max_tokens: int
    effort: str
    # A JSON schema the reply must follow, or None for plain text.
    schema: dict | None = None

    @property
    def chars(self) -> int:
        return len(self.system) + len(self.user)


@dataclass(frozen=True)
class Evidence:
    path: str
    # The scrubbed text, or None for a file copied as it is (an image, a binary): its name goes,
    # its bytes don't.
    text: str | None


@dataclass(frozen=True)
class TaskFolder:
    """The parts of a built folder this job reads. Only `question`, `context`, `protocol` and
    `evidence` are ever sent to a model being checked."""

    question: str
    context: str
    protocol: str
    evidence: tuple[Evidence, ...]
    answer_key: str


class FolderProblem(Exception):
    """The folder can't be read: it's missing, too big, or not what its manifest says."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def read_folder(store: PreviewStore, storage_prefix: str | None, manifest: dict) -> TaskFolder:
    """Reads slice E's folder: <prefix>/task.zip, its files under one task-<id>/ folder, and
    the manifest's evidence list, which says which evidence files were scrubbed as text."""
    zip_info = manifest.get("zip") or {}
    if storage_prefix is None:
        raise FolderProblem("no_folder")
    if int(zip_info.get("bytes") or 0) > MAX_ZIP_BYTES:
        raise FolderProblem("too_long")
    data = store.get(f"{storage_prefix.rstrip('/')}/task.zip")
    if data is None:
        raise FolderProblem("no_folder")
    if zip_info.get("sha256") and hashlib.sha256(data).hexdigest() != zip_info["sha256"]:
        raise FolderProblem("no_folder")
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        files = {_inside(name): name for name in z.namelist() if not name.endswith("/")}

        def text(path: str) -> str:
            name = files.get(path)
            return z.read(name).decode("utf-8", errors="replace").strip() if name else ""

        evidence = tuple(
            Evidence(e["path"], text(e["path"]) if e.get("treatment") == "scrubbed" else None)
            for e in manifest.get("evidence") or []
            if e.get("path") in files
        )
        return TaskFolder(
            question=text("question.md"),
            context=text("context.md"),
            protocol=text("protocol_as_run.md"),
            evidence=evidence,
            answer_key=text("answer_key.md"),
        )


def _inside(name: str) -> str:
    """A path inside the folder, without the task-<id>/ folder it's zipped in."""
    first, _, rest = name.partition("/")
    return rest if first.startswith("task-") and rest else name


SOLVER_SYSTEM = (
    "You are being tested on whether you can find why a real lab experiment went wrong. "
    "Below is one run: the question to answer, what the scientist was trying to do, the "
    "protocol as it was actually run, and the evidence the run produced. People's names have "
    "been replaced.\n\n"
    "Answer the question. Name the single most likely cause of what went wrong and say, in at "
    "most five sentences, what in the evidence points to it. Commit to one cause; a list of "
    "possibilities is not an answer."
)


NOT_TEXT = "(a file that isn't text; not included)"


def solver_ask(folder: TaskFolder) -> Ask:
    """What each model being checked is sent. Built only from the four parts that may go."""
    parts = [
        f"## Question\n\n{folder.question}",
        f"## Context\n\n{folder.context or 'None given.'}",
        f"## Protocol as run\n\n{folder.protocol or 'None given.'}",
        "## Evidence",
    ]
    for e in folder.evidence:
        body = f"```\n{e.text}\n```" if e.text is not None else NOT_TEXT
        parts.append(f"### {e.path}\n\n{body}")
    if not folder.evidence:
        parts.append("No evidence files.")
    return Ask(SOLVER_SYSTEM, "\n\n".join(parts), SOLVER_MAX_TOKENS, SOLVER_EFFORT)


GRADER_SYSTEM = (
    "You grade one answer to a question about why a lab experiment failed. The lab confirmed "
    "the real cause (by a control, a repeat, or the PI's judgment). Decide strictly whether "
    "the answer names that cause.\n\n"
    "- solved: the answer's main cause is the confirmed cause, or a more specific statement of "
    "it.\n"
    "- partial: the answer has the confirmed cause only among several candidates, or the right "
    "step with the wrong mechanism.\n"
    "- not_solved: the answer's main cause is something else, or it names no cause.\n"
    "- unclear: you can't tell from the words.\n\n"
    "Give no credit for careful reasoning that ends somewhere else, and none for listing many "
    "causes. The reason is one or two plain sentences a biology student would follow."
)

GRADE_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["solved", "partial", "not_solved", "unclear"]},
        "reason": {"type": "string"},
    },
    "required": ["verdict", "reason"],
    "additionalProperties": False,
}


class Grade(BaseModel):
    verdict: Literal["solved", "partial", "not_solved", "unclear"]
    reason: str


def grader_ask(folder: TaskFolder, answer: str) -> Ask:
    user = (
        f"## Question\n\n{folder.question}\n\n## Confirmed cause\n\n{folder.answer_key}\n\n"
        f"## Answer to grade\n\n{answer}"
    )
    return Ask(GRADER_SYSTEM, user, GRADER_MAX_TOKENS, GRADER_EFFORT, GRADE_SCHEMA)


def parse_grade(text: str | None) -> Grade:
    """The grader's reply, or an unclear verdict when it can't be read: a scientist decides."""
    try:
        grade = Grade.model_validate_json(text or "")
    except ValidationError:
        return Grade(verdict="unclear", reason="Binary couldn't read the grader's reply.")
    reason = grade.reason.strip()[:2000] or "The grader gave no reason."
    return Grade(verdict=grade.verdict, reason=reason)


def ceiling_usd(model: str, ask: Ask) -> Decimal:
    """The most one call can cost: every character a token at the dense end, and the whole
    output ceiling used."""
    price_in, price_out = PRICES[model]
    tokens_in = math.ceil(ask.chars / CHARS_PER_TOKEN)
    return (tokens_in * price_in + ask.max_tokens * price_out) / 1_000_000


def published_ceiling_usd(model: str, grader: str) -> Decimal:
    """The most checking one model can cost, before the task is known: the longest task it
    can be sent, then grading the longest answer it can give."""
    solver = Ask(SOLVER_SYSTEM, "x" * MAX_PROMPT_CHARS, SOLVER_MAX_TOKENS, SOLVER_EFFORT)
    longest_answer = "x" * (SOLVER_MAX_TOKENS * 4)
    grading = Ask(
        GRADER_SYSTEM,
        "x" * (MAX_QUESTION_CHARS + MAX_CAUSE_CHARS) + longest_answer,
        GRADER_MAX_TOKENS,
        GRADER_EFFORT,
    )
    return (ceiling_usd(model, solver) + ceiling_usd(grader, grading)).quantize(Decimal("0.01"))


def publish_setup(conn: psycopg.Connection, setup: Setup) -> None:
    grader = setup.grader.model if setup.grader else None
    models = [
        {"model": m, "ceiling_usd": float(published_ceiling_usd(m, grader) if grader else 0)}
        for m in setup.routes
    ]
    conn.execute(
        """
        insert into model_check_setup (id, models, unreachable, grader, cost_cap_usd, missing)
        values (true, %s, %s, %s, %s, %s)
        on conflict (id) do update set
          models = excluded.models, unreachable = excluded.unreachable, grader = excluded.grader,
          cost_cap_usd = excluded.cost_cap_usd, missing = excluded.missing, updated_at = now()
        where (model_check_setup.models, model_check_setup.unreachable, model_check_setup.grader,
               model_check_setup.cost_cap_usd, model_check_setup.missing)
          is distinct from (excluded.models, excluded.unreachable, excluded.grader,
               excluded.cost_cap_usd, excluded.missing)
        """,
        (
            json.dumps(models),
            json.dumps([{"model": m, "needs": needs} for m, needs in setup.unreachable]),
            grader,
            setup.cost_cap_usd,
            list(setup.missing),
        ),
    )


# ---- Sending.


@dataclass(frozen=True)
class Reply:
    # The answer text, or None when the model declined, ran out of room or said nothing.
    text: str | None
    cost_usd: Decimal


class Unreachable(Exception):
    """The provider couldn't be reached or refused the request. The message names the error,
    never the prompt."""


class CheckClient(Protocol):
    def ask(self, route: Route, ask: Ask) -> Reply: ...


def cost_from_tokens(model: str, tokens_in: int, tokens_out: int) -> Decimal:
    price_in, price_out = PRICES[model]
    return (tokens_in * price_in + tokens_out * price_out) / 1_000_000


class HttpCheckClient:
    """OpenRouter and the OpenAI-compatible providers over httpx; Anthropic through its SDK.
    No retries: a model that can't be reached is recorded as such, and the person can ask
    again."""

    # The transports are for tests: the Anthropic SDK runs on httpx2, so it takes its own.
    def __init__(
        self,
        timeout: float = 180.0,
        transport: httpx.BaseTransport | None = None,
        anthropic_transport: object | None = None,
    ) -> None:
        self._timeout = timeout
        self._http = httpx.Client(timeout=timeout, transport=transport)
        self._anthropic_transport = anthropic_transport

    def ask(self, route: Route, ask: Ask) -> Reply:
        if route.via == "anthropic":
            return self._anthropic(route, ask)
        base = OPENROUTER_URL if route.via == "openrouter" else DIRECT[route.via][1]
        body: dict = {
            "model": route.provider_model,
            "messages": [
                {"role": "system", "content": ask.system},
                {"role": "user", "content": ask.user},
            ],
            "max_completion_tokens": ask.max_tokens,
        }
        if route.via == "openrouter":
            body["reasoning"] = {"effort": ask.effort}
            body["provider"] = {"require_parameters": True}
        else:
            body["reasoning_effort"] = ask.effort
        if ask.schema is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "grade", "strict": True, "schema": ask.schema},
            }
        try:
            res = self._http.post(
                f"{base}/chat/completions",
                json=body,
                headers={"authorization": f"Bearer {route.key.get_secret_value()}"},
            )
        except httpx.HTTPError as e:
            raise Unreachable(type(e).__name__) from e
        if res.status_code >= 400:
            raise Unreachable(f"HTTP {res.status_code}")
        data = res.json()
        usage = data.get("usage") or {}
        if usage.get("cost") is not None:
            cost = Decimal(str(usage["cost"]))
        elif "prompt_tokens" in usage:
            cost = cost_from_tokens(
                route.model, int(usage["prompt_tokens"]), int(usage.get("completion_tokens", 0))
            )
        else:
            # Unknown spend counts as the worst case, so the cap still holds.
            cost = ceiling_usd(route.model, ask)
        choice = (data.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content")
        ok = choice.get("finish_reason") == "stop" and isinstance(content, str) and content.strip()
        return Reply(content.strip() if ok else None, cost)

    def _anthropic(self, route: Route, ask: Ask) -> Reply:
        import anthropic

        http = None
        if self._anthropic_transport is not None:
            import httpx2

            http = httpx2.Client(transport=self._anthropic_transport)  # type: ignore[arg-type]
        client = anthropic.Anthropic(
            api_key=route.key.get_secret_value(),
            max_retries=0,
            timeout=self._timeout,
            http_client=http,
        )
        output_config: dict = {"effort": ask.effort}
        if ask.schema is not None:
            output_config["format"] = {"type": "json_schema", "schema": ask.schema}
        try:
            # No fallback model: the check measures this model, so a refusal is its answer.
            response = client.messages.create(
                model=route.provider_model,
                max_tokens=ask.max_tokens,
                system=ask.system,
                messages=[{"role": "user", "content": ask.user}],
                output_config=output_config,
            )
        except anthropic.APIError as e:
            raise Unreachable(type(e).__name__) from e
        u = response.usage
        cost = cost_from_tokens(route.model, u.input_tokens, u.output_tokens)
        text = "".join(b.text for b in response.content if b.type == "text").strip()
        return Reply(text if response.stop_reason == "end_turn" and text else None, cost)


# ---- The job.


@dataclass(frozen=True)
class Row:
    id: UUID
    model: str
    state: str
    answer: str | None
    verdict: str | None
    cost_usd: Decimal


def exportable(conn: psycopg.Connection, task_id: UUID) -> bool:
    try:
        conn.execute("select assert_exportable(%s)", (task_id,))
    except psycopg.Error as e:
        if e.sqlstate == "BL951":
            return False
        raise
    return True


SOLVED = {"solved": True, "not_solved": False}
OFF = "Sharing went off before the grader saw this answer."


def _set(conn: psycopg.Connection, row_id: UUID, **cols: object) -> None:
    names = ", ".join(f"{k} = %s" for k in cols)
    conn.execute(f"update task_model_runs set {names} where id = %s", (*cols.values(), row_id))


def _to_scientist(conn: psycopg.Connection, row: Row, reason: str, cost: Decimal) -> None:
    _set(
        conn,
        row.id,
        verdict="unclear",
        reason=reason,
        solved=None,
        graded_at=datetime.now(UTC),
        cost_usd=cost,
    )


def run_check(
    conn: psycopg.Connection,
    store: PreviewStore,
    client: CheckClient,
    setup: Setup,
    check_id: UUID,
) -> str:
    """Answers every waiting model of one check and grades every ungraded answer. Run again
    after a crash, it picks up where it stopped: answered rows aren't asked again."""
    found = conn.execute(
        "select m.task_id, m.cost_cap_usd, t.storage_prefix, t.manifest from task_model_runs m"
        " join task_exports t on t.id = m.task_id where m.check_id = %s limit 1",
        (check_id,),
    ).fetchone()
    if found is None:
        return "gone"
    task_id, cap, prefix, manifest = found
    rows = [
        Row(*r)
        for r in conn.execute(
            "select id, model, state, answer, verdict, cost_usd from task_model_runs"
            " where check_id = %s order by model",
            (check_id,),
        )
    ]
    spent = sum((r.cost_usd for r in rows), Decimal(0))
    todo = [
        r for r in rows if r.state == "waiting" or (r.state == "answered" and r.verdict is None)
    ]
    if not todo:
        return "done"

    def stop(code: str, reason: str, among: Iterable[Row]) -> None:
        for r in among:
            if r.state == "waiting":
                _set(conn, r.id, state="refused" if code == "not_shared" else "skipped", error=code)
            elif r.verdict is None:
                _to_scientist(conn, r, reason, r.cost_usd)

    if not exportable(conn, task_id):
        stop("not_shared", OFF, todo)
        return "refused"
    try:
        folder = read_folder(store, prefix, manifest or {})
    except FolderProblem as e:
        stop(e.code, "Binary couldn't read the task folder to grade this answer.", todo)
        return e.code
    solve = solver_ask(folder)
    too_long = solve.chars > MAX_PROMPT_CHARS
    # Room kept for grading the longest answer a model can give, so a check that can afford to
    # ask a model can also afford to grade it.
    grade_worst = (
        ceiling_usd(setup.grader.model, grader_ask(folder, "x" * (SOLVER_MAX_TOKENS * 4)))
        if setup.grader
        else Decimal(0)
    )

    for i, row in enumerate(todo):
        answer, cost = row.answer, row.cost_usd
        if row.state == "waiting":
            route = setup.routes.get(row.model)
            if too_long:
                _set(conn, row.id, state="skipped", error="too_long")
                continue
            if route is None:
                _set(conn, row.id, state="failed", error="no_key")
                continue
            if spent + ceiling_usd(row.model, solve) + grade_worst > cap:
                _set(conn, row.id, state="skipped", error="cost_cap")
                continue
            if not exportable(conn, task_id):
                stop("not_shared", OFF, todo[i:])
                return "refused"
            try:
                reply = client.ask(route, solve)
            except Unreachable as e:
                _set(conn, row.id, state="failed", error=str(e)[:200])
                continue
            spent += reply.cost_usd
            cost = row.cost_usd + reply.cost_usd
            if reply.text is None:
                _set(conn, row.id, state="failed", error="no_answer", cost_usd=cost)
                continue
            answer = reply.text
            _set(conn, row.id, state="answered", answer=answer, cost_usd=cost)
        assert answer is not None
        grade_row = Row(row.id, row.model, "answered", answer, None, cost)
        if setup.grader is None:
            _to_scientist(conn, grade_row, "No grader is set up.", cost)
            continue
        grading = grader_ask(folder, answer)
        if spent + ceiling_usd(setup.grader.model, grading) > cap:
            _to_scientist(conn, grade_row, "Grading it could have passed the cost cap.", cost)
            continue
        if not exportable(conn, task_id):
            stop(code="not_shared", reason=OFF, among=[grade_row, *todo[i + 1 :]])
            return "refused"
        try:
            graded = client.ask(setup.grader, grading)
        except Unreachable:
            _to_scientist(conn, grade_row, "The grader couldn't be reached.", cost)
            continue
        spent += graded.cost_usd
        grade = parse_grade(graded.text)
        _set(
            conn,
            row.id,
            verdict=grade.verdict,
            reason=grade.reason,
            grader=setup.grader.model,
            solved=SOLVED.get(grade.verdict),
            graded_at=datetime.now(UTC),
            cost_usd=cost + graded.cost_usd,
        )
    return "checked"


def due_checks(conn: psycopg.Connection) -> list[tuple[UUID, UUID]]:
    """(lab, check) for every check with a model still waiting or an answer still ungraded."""
    return [
        (r[0], r[1])
        for r in conn.execute(
            "select distinct lab_id, check_id from task_model_runs where check_id is not null"
            " and (state = 'waiting' or (state = 'answered' and verdict is null))"
        )
    ]


def check_job(rt: Runtime, check_id: UUID, client: CheckClient | None = None) -> str:
    setup = setup_from(CheckSettings())
    with rt.pool.connection() as conn:
        return run_check(conn, rt.previews, client or HttpCheckClient(), setup, check_id)


def tend(rt: Runtime) -> list[tuple[UUID, UUID]]:
    """Says what this worker can run, then lists the checks to run."""
    with rt.pool.connection() as conn:
        publish_setup(conn, setup_from(CheckSettings()))
        return due_checks(conn)


def register(app: App) -> None:
    """Adds the model check's jobs to the worker's app. jobs.py calls it once, with
    `model_check.register(app)` after its own tasks."""

    def defer(lab_id: UUID, check_id: UUID) -> bool:
        # One job per check at a time: a second beside it would ask the same models again.
        lock = f"model_check:{check_id}"
        try:
            app.configure_task("model_check", queueing_lock=lock, lock=lock).defer(
                lab_id=str(lab_id), check_id=str(check_id)
            )
        except AlreadyEnqueued:
            return False
        return True

    @app.task(name="model_check", pass_context=True, retry=RetryStrategy(max_attempts=3, wait=30))
    def model_check(context: JobContext, lab_id: str, check_id: str) -> None:
        outcome = check_job(context.additional_context["runtime"], UUID(check_id))
        log.info("model check %s: %s", check_id, outcome)

    @app.periodic(cron="* * * * * */10")
    @app.task(name="tend_model_checks", pass_context=True, queueing_lock="tend_model_checks")
    async def tend_model_checks(context: JobContext, timestamp: int) -> None:
        """Says what this worker's keys can run, then queues every check someone asked for
        that still has a model waiting or an answer ungraded."""
        todo = await asyncio.to_thread(tend, context.additional_context["runtime"])
        deferred = sum(defer(lab_id, check_id) for lab_id, check_id in todo)
        if deferred:
            log.info("deferred %d model checks", deferred)

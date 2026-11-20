from __future__ import annotations

import hashlib
import io
import json
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal

import httpx
import psycopg
import pytest
from conftest import committed_as_user
from pydantic import SecretStr

from bl_worker import model_check
from bl_worker.model_check import (
    DEFAULT_GRADER,
    DEFAULT_MODELS,
    Ask,
    CheckSettings,
    HttpCheckClient,
    Reply,
    Route,
    Setup,
    Unreachable,
    run_check,
    setup_from,
)

ANSWER_KEY = "The lysis buffer was made at pH 9 instead of pH 7.4 (answer key 7f3a)."
RUBRIC = '[{"criterion": "Names the buffer pH (rubric 9c1d)", "points": 2}]'
REVIEW = "Second scientist agrees (review note 44be)."
PROVENANCE = '{"confirmed_by": "Confirmer (provenance 0b2e)"}'
QUESTION = "Why did the prep give no protein?"
CSV = "well,od600\nA1,0.02\nA2,0.03\n"


@dataclass
class FakeClient:
    """Answers from functions of the request and records every request it is sent. Nothing
    leaves the machine."""

    solve: Callable[[Route, Ask], str | None] = lambda route, ask: "The buffer pH was wrong."
    grade: Callable[[Route, Ask], str | None] = lambda route, ask: json.dumps(
        {"verdict": "solved", "reason": "It names the buffer pH."}
    )
    cost: Decimal = Decimal("0.01")
    calls: list[tuple[str, Ask]] = field(default_factory=list)

    def ask(self, route: Route, ask: Ask) -> Reply:
        self.calls.append((route.model, ask))
        answer = (self.grade if ask.schema is not None else self.solve)(route, ask)
        return Reply(answer, self.cost)

    @property
    def solver_calls(self) -> list[tuple[str, Ask]]:
        return [c for c in self.calls if c[1].schema is None]

    @property
    def grader_calls(self) -> list[tuple[str, Ask]]:
        return [c for c in self.calls if c[1].schema is not None]


def keyed(**keys: str) -> CheckSettings:
    return CheckSettings(_env_file=None, **{k: SecretStr(v) for k, v in keys.items()})  # type: ignore[call-arg, arg-type]


SETUP = setup_from(keyed(openrouter_api_key="sk-or-test"))


@dataclass(frozen=True)
class Task:
    lab: object
    run: object
    task_id: object
    check: object


def folder_zip(task_id, *, csv: str = CSV) -> bytes:
    root = f"task-{task_id}"
    files = {
        "question.md": QUESTION,
        "context.md": "Trying to purify BM3 from E. coli. Expected a band at 118 kDa; saw none.",
        "protocol_as_run.md": "1. Lyse in buffer A.\n2. Spin 20 min.",
        "protocol_as_written.md": "1. Lyse in buffer A at pH 7.4.",
        "answer_key.md": ANSWER_KEY,
        "rubric.json": RUBRIC,
        "review_notes.md": REVIEW,
        "provenance.json": PROVENANCE,
        "evidence/01-plate.csv": csv,
        "evidence/02-gel.png": "\x89PNG not text",
        "manifest.json": "{}",
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for path, text in files.items():
            z.writestr(f"{root}/{path}", text)
    return buf.getvalue()


@pytest.fixture
def task(rt, conn, make_lab):
    """A failed run with a confirmed cause, shared by an agreed lab, built into a folder E's
    way: <lab>/exports/<id>/task.zip and a manifest saying which evidence was scrubbed."""

    def make(csv: str = CSV):
        lab = make_lab("checked")
        (person,) = conn.execute(
            "insert into people (lab_id, display_name) values (%s, 'Priya') returning id",
            (lab.id,),
        ).fetchone()
        (run,) = conn.execute(
            "insert into runs (lab_id, title, status, status_at, confirmed_cause, confirmed_by,"
            " confirm_method, confirmed_at) values (%s, 'BM3 prep', 'failed', now(), %s, %s,"
            " 'control', now()) returning id",
            (lab.id, ANSWER_KEY, person),
        ).fetchone()
        conn.execute("update runs set share = true where id = %s", (run,))
        conn.execute(
            "update labs set sharing_agreed_at = now(), sharing_agreement = 'v1' where id = %s",
            (lab.id,),
        )
        (grant,) = conn.execute(
            "insert into run_log (lab_id, run_id, via, action) values (%s, %s, 'person',"
            " 'export.allowed') returning id",
            (lab.id, run),
        ).fetchone()
        (task_id,) = conn.execute("select gen_random_uuid()").fetchone()
        prefix = f"{lab.id}/exports/{task_id}"
        data = folder_zip(task_id, csv=csv)
        rt.previews.put(f"{prefix}/task.zip", data, "application/zip")
        manifest = {
            "evidence": [
                {"path": "evidence/01-plate.csv", "treatment": "scrubbed"},
                {"path": "evidence/02-gel.png", "treatment": "as_is"},
            ],
            "zip": {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()},
        }
        conn.execute(
            "insert into task_exports (id, lab_id, run_id, grant_id, purpose, storage_prefix,"
            " manifest) values (%s, %s, %s, %s, 'task_folder', %s, %s)",
            (task_id, lab.id, run, grant, prefix, json.dumps(manifest)),
        )
        model_check.publish_setup(conn, SETUP)
        with committed_as_user(conn, lab.user_id):
            (check,) = conn.execute("select request_model_check(%s)", (task_id,)).fetchone()
        return Task(lab, run, task_id, check)

    return make


def rows(conn, check):
    return conn.execute(
        "select model, state, answer, verdict, reason, solved, error, cost_usd from"
        " task_model_runs where check_id = %s order by model",
        (check,),
    ).fetchall()


def test_each_model_answers_and_the_grader_judges_it_against_the_confirmed_cause(rt, conn, task):
    t = task()
    verdicts = {
        "anthropic/claude-opus-5.5": "solved",
        "google/gemini-4-neon": "not_solved",
        "openai/gpt-6.2-astra": "partial",
        "x-ai/grok-4.7": "unclear",
    }
    answers = {m: f"{m} thinks the buffer was off." for m in verdicts}
    by_answer = {a: m for m, a in answers.items()}

    def grade(route, ask):
        model = next(m for a, m in by_answer.items() if a in ask.user)
        return json.dumps({"verdict": verdicts[model], "reason": f"Because {model}."})

    fake = FakeClient(solve=lambda route, ask: answers[route.model], grade=grade)

    assert run_check(conn, rt.previews, fake, SETUP, t.check) == "checked"

    assert rows(conn, t.check) == [
        (
            m,
            "answered",
            answers[m],
            v,
            f"Because {m}.",
            model_check.SOLVED.get(v),
            None,
            Decimal("0.020000"),
        )
        for m, v in sorted(verdicts.items())
    ]
    assert [m for m, _ in fake.solver_calls] == sorted(DEFAULT_MODELS)
    assert {m for m, _ in fake.grader_calls} == {DEFAULT_GRADER}
    # A second t.run of the same t.check asks nobody again.
    assert run_check(conn, rt.previews, fake, SETUP, t.check) == "done"
    assert len(fake.calls) == 8


def test_the_answer_key_rubric_and_review_never_reach_a_model_being_checked(rt, conn, task):
    t = task()
    fake = FakeClient()
    run_check(conn, rt.previews, fake, SETUP, t.check)

    assert len(fake.solver_calls) == 4
    for _, ask in fake.solver_calls:
        sent = ask.system + ask.user
        for secret in ("7f3a", "pH 9", "9c1d", "44be", "0b2e"):
            assert secret not in sent
        assert QUESTION in sent and "A1,0.02" in sent and "Lyse in buffer A" in sent
        assert "evidence/02-gel.png" in sent and "PNG" not in sent
    # Only the grader sees the confirmed cause, and nobody sees the rubric or the review.
    for _, ask in fake.grader_calls:
        sent = ask.system + ask.user
        assert ANSWER_KEY in sent
        assert "9c1d" not in sent and "44be" not in sent and "A1,0.02" not in sent


def test_a_run_switched_off_between_export_and_the_check_is_refused_before_any_call(rt, conn, task):
    t = task()
    conn.execute("update runs set share = false where id = %s", (t.run,))
    fake = FakeClient()

    assert run_check(conn, rt.previews, fake, SETUP, t.check) == "refused"

    assert fake.calls == []
    assert {(r[1], r[6]) for r in rows(conn, t.check)} == {("refused", "not_shared")}


def test_the_lab_withdrawing_its_agreement_is_refused_before_any_call(rt, conn, task):
    t = task()
    conn.execute(
        "update labs set sharing_agreed_at = null, sharing_agreement = null where id = %s",
        (t.lab.id,),
    )
    fake = FakeClient()
    assert run_check(conn, rt.previews, fake, SETUP, t.check) == "refused"
    assert fake.calls == []


def test_sharing_going_off_mid_check_stops_before_the_next_call(rt, conn, task):
    t = task()

    def solve_then_switch_off(route, ask):
        conn.execute("update runs set share = false where id = %s", (t.run,))
        return "The buffer pH was wrong."

    fake = FakeClient(solve=solve_then_switch_off)
    assert run_check(conn, rt.previews, fake, SETUP, t.check) == "refused"

    # One model answered; nothing else left, not even its grading (which carries the answer key).
    assert len(fake.calls) == 1
    first, *rest = rows(conn, t.check)
    assert first[1:6] == ("answered", "The buffer pH was wrong.", "unclear", model_check.OFF, None)
    assert {(r[1], r[6]) for r in rest} == {("refused", "not_shared")}


def test_sharing_going_off_while_an_answer_is_graded_stops_the_next_model(rt, conn, task):
    t = task()

    def grade_then_switch_off(route, ask):
        conn.execute("update runs set share = false where id = %s", (t.run,))
        return json.dumps({"verdict": "solved", "reason": "It names the buffer pH."})

    fake = FakeClient(grade=grade_then_switch_off)
    assert run_check(conn, rt.previews, fake, SETUP, t.check) == "refused"

    assert len(fake.solver_calls) == 1 and len(fake.grader_calls) == 1
    first, *rest = rows(conn, t.check)
    assert first[1:6] == (
        "answered",
        "The buffer pH was wrong.",
        "solved",
        "It names the buffer pH.",
        True,
    )
    assert {(r[1], r[6]) for r in rest} == {("refused", "not_shared")}


def test_the_cost_cap_stops_before_any_call_that_could_pass_it(rt, conn, task):
    t = task()
    conn.execute("update task_model_runs set cost_cap_usd = 0.30 where check_id = %s", (t.check,))
    fake = FakeClient(cost=Decimal("0.10"))

    run_check(conn, rt.previews, fake, SETUP, t.check)

    asked = {m for m, _ in fake.solver_calls}
    states = {r[0]: (r[1], r[6]) for r in rows(conn, t.check)}
    assert asked and asked != set(DEFAULT_MODELS)
    for model, state in states.items():
        assert state == (("answered", None) if model in asked else ("skipped", "cost_cap"))
    spent = sum(r[7] for r in rows(conn, t.check))
    assert spent <= Decimal("0.30")


def test_a_model_that_cant_be_reached_or_a_grade_that_cant_be_read_is_recorded_as_such(
    rt, conn, task
):
    t = task()

    def solve(route, ask):
        if route.model == "x-ai/grok-4.7":
            raise Unreachable("HTTP 503")
        return None if route.model == "google/gemini-4-neon" else "The buffer pH."

    class Flaky(FakeClient):
        def ask(self, route, ask):
            if ask.schema is None and route.model == "x-ai/grok-4.7":
                self.calls.append((route.model, ask))
                raise Unreachable("HTTP 503")
            return super().ask(route, ask)

    fake = Flaky(solve=solve, grade=lambda route, ask: "not json at all")
    run_check(conn, rt.previews, fake, SETUP, t.check)

    got = {r[0]: (r[1], r[3], r[5], r[6]) for r in rows(conn, t.check)}
    assert got == {
        "anthropic/claude-opus-5.5": ("answered", "unclear", None, None),
        "google/gemini-4-neon": ("failed", None, None, "no_answer"),
        "openai/gpt-6.2-astra": ("answered", "unclear", None, None),
        "x-ai/grok-4.7": ("failed", None, None, "HTTP 503"),
    }


def test_a_check_that_crashed_picks_up_without_asking_a_model_twice(rt, conn, task):
    t = task()

    class Crash(Exception):
        pass

    def grade(route, ask):
        if "gpt" in ask.user:
            raise Crash
        return json.dumps({"verdict": "not_solved", "reason": "Different cause."})

    fake = FakeClient(solve=lambda route, ask: f"{route.model}: contamination.", grade=grade)
    with pytest.raises(Crash):
        run_check(conn, rt.previews, fake, SETUP, t.check)
    asked_before = [m for m, _ in fake.solver_calls]

    fake.grade = lambda route, ask: json.dumps({"verdict": "not_solved", "reason": "Different."})
    run_check(conn, rt.previews, fake, SETUP, t.check)

    asked = [m for m, _ in fake.solver_calls]
    assert len(asked) == len(set(asked)) == 4
    assert asked[: len(asked_before)] == asked_before
    assert {r[1] for r in rows(conn, t.check)} == {"answered"}
    assert all(r[3] is not None for r in rows(conn, t.check))


def test_a_task_too_long_to_send_is_skipped_rather_than_cut(rt, conn, task):
    t = task(csv="1," * model_check.MAX_PROMPT_CHARS)
    fake = FakeClient()
    run_check(conn, rt.previews, fake, SETUP, t.check)
    assert fake.calls == []
    assert {(r[1], r[6]) for r in rows(conn, t.check)} == {("skipped", "too_long")}


def test_only_open_checks_are_due(rt, conn, task):
    t = task()
    assert model_check.due_checks(conn) == [(t.lab.id, t.check)]
    run_check(conn, rt.previews, FakeClient(), SETUP, t.check)
    assert model_check.due_checks(conn) == []


def test_without_keys_nothing_can_run_and_the_page_is_told_what_to_add(rt, conn, task):
    none = setup_from(keyed())
    assert not none.ready and none.missing == ("OPENROUTER_API_KEY",)
    assert {needs for _, needs in none.unreachable} >= {"OPENROUTER_API_KEY or OPENAI_API_KEY"}

    t = task()
    model_check.publish_setup(conn, none)
    (published,) = conn.execute("select models from model_check_setup").fetchone()
    assert published == []
    conn.execute("delete from task_model_runs where check_id = %s", (t.check,))
    with pytest.raises(psycopg.Error) as refused, committed_as_user(conn, t.lab.user_id):
        conn.execute("select request_model_check(%s)", (t.task_id,))
    assert refused.value.sqlstate == "BL972"


def test_a_providers_own_key_reaches_only_its_models_and_a_model_without_a_price_never_runs():
    s = keyed(anthropic_api_key="sk-ant-test")
    setup = setup_from(
        CheckSettings(
            _env_file=None,  # type: ignore[call-arg]
            anthropic_api_key=SecretStr("sk-ant-test"),
            model_check_models="anthropic/claude-opus-5.5,openai/gpt-6.2-astra,mystery/model-1",
        )
    )
    assert setup_from(s).grader == Route(DEFAULT_GRADER, "anthropic", SecretStr("sk-ant-test"))
    assert list(setup.routes) == ["anthropic/claude-opus-5.5"]
    assert setup.routes["anthropic/claude-opus-5.5"].provider_model == "claude-opus-5-5"
    assert dict(setup.unreachable) == {
        "openai/gpt-6.2-astra": "OPENROUTER_API_KEY or OPENAI_API_KEY",
        "mystery/model-1": "a price in model_check.PRICES",
    }
    assert setup.ready


def test_the_published_ceiling_covers_the_worst_case_of_the_longest_task():
    grader = DEFAULT_GRADER
    for model in DEFAULT_MODELS:
        solver = Ask("s", "x" * model_check.MAX_PROMPT_CHARS, model_check.SOLVER_MAX_TOKENS, "high")
        folder = model_check.TaskFolder("q" * 4000, "", "", (), "c" * 4000)
        grading = model_check.grader_ask(folder, "a" * model_check.SOLVER_MAX_TOKENS * 4)
        worst = model_check.ceiling_usd(model, solver) + model_check.ceiling_usd(grader, grading)
        assert model_check.published_ceiling_usd(model, grader) >= worst.quantize(Decimal("0.01"))
    total = sum(model_check.published_ceiling_usd(m, grader) for m in DEFAULT_MODELS)
    assert total <= Decimal("2.00"), "the default list fits under the default cap"


def captured(response: dict) -> tuple[HttpCheckClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=response)

    return HttpCheckClient(transport=httpx.MockTransport(handle)), seen


def test_openrouter_is_sent_the_effort_ceiling_and_schema_and_its_cost_is_read_back():
    client, seen = captured(
        {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"content": '{"verdict": "solved", "reason": "r"}'},
                }
            ],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10, "cost": 0.0123},
        }
    )
    route = Route("anthropic/claude-sonnet-5.5", "openrouter", SecretStr("sk-or-test"))
    ask = Ask("sys", "user", 2000, "medium", model_check.GRADE_SCHEMA)
    reply = client.ask(route, ask)

    assert reply == Reply('{"verdict": "solved", "reason": "r"}', Decimal("0.0123"))
    (req,) = seen
    assert str(req.url) == "https://openrouter.ai/api/v1/chat/completions"
    assert req.headers["authorization"] == "Bearer sk-or-test"
    body = json.loads(req.content)
    assert body["model"] == "anthropic/claude-sonnet-5.5"
    assert body["reasoning"] == {"effort": "medium"} and body["max_completion_tokens"] == 2000
    assert body["response_format"]["json_schema"]["schema"] == model_check.GRADE_SCHEMA
    assert body["provider"] == {"require_parameters": True}


def test_a_cut_off_reply_is_no_answer_and_an_unknown_cost_counts_as_the_worst_case():
    client, _ = captured(
        {"choices": [{"finish_reason": "length", "message": {"content": "The buf"}}]}
    )
    route = Route("openai/gpt-6.2-astra", "openai", SecretStr("sk-test"))
    ask = Ask("sys", "user", 8000, "high")
    reply = client.ask(route, ask)
    assert reply.text is None
    assert reply.cost_usd == model_check.ceiling_usd(route.model, ask)


def test_a_provider_error_is_unreachable_without_the_prompt_in_it():
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "slow down"}})

    client = HttpCheckClient(transport=httpx.MockTransport(handle))
    with pytest.raises(Unreachable) as e:
        client.ask(
            Route("x-ai/grok-4.7", "openrouter", SecretStr("k")),
            Ask("s", "secret task", 10, "high"),
        )
    assert str(e.value) == "HTTP 429"


def test_anthropic_is_called_through_its_sdk_with_no_fallback_model():
    import httpx2

    seen: list[httpx2.Request] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(
            200,
            json={
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "model": "claude-opus-5-5",
                "content": [{"type": "text", "text": "The buffer pH."}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 1000, "output_tokens": 100},
            },
        )

    client = HttpCheckClient(anthropic_transport=httpx2.MockTransport(handle))
    reply = client.ask(
        Route("anthropic/claude-opus-5.5", "anthropic", SecretStr("sk-ant-test")),
        Ask("sys", "user", 8000, "high"),
    )
    assert reply == Reply("The buffer pH.", Decimal("0.006"))
    (req,) = seen
    body = json.loads(req.content)
    assert body["model"] == "claude-opus-5-5" and body["output_config"] == {"effort": "high"}
    assert "fallbacks" not in body
    assert "sk-ant-test" in req.headers.get("authorization", "") + req.headers.get("x-api-key", "")


def test_the_setup_is_published_once_and_rewritten_only_when_it_changes(conn):
    model_check.publish_setup(conn, SETUP)
    (first,) = conn.execute("select updated_at from model_check_setup").fetchone()
    model_check.publish_setup(conn, SETUP)
    (again,) = conn.execute("select updated_at from model_check_setup").fetchone()
    assert again == first
    (models, grader, cap) = conn.execute(
        "select models, grader, cost_cap_usd from model_check_setup"
    ).fetchone()
    assert [m["model"] for m in models] == list(DEFAULT_MODELS)
    assert grader == DEFAULT_GRADER and cap == Decimal("2.00")
    assert isinstance(SETUP, Setup) and SETUP.ready

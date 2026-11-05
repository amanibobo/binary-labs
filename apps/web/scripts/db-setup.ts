import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Rebuilds the local test database from db/ before the db test project runs.
// BL_WEB_TEST_DB lets two checkouts run their suites side by side.
const DB = process.env.BL_WEB_TEST_DB ?? "binary_labs_web_test";
const repo = join(__dirname, "../../..");
const brewBin = "/opt/homebrew/opt/postgresql@17/bin";
const bin = (name: string) => (existsSync(join(brewBin, name)) ? join(brewBin, name) : name);

export default function setup() {
  execFileSync(bin("dropdb"), ["--if-exists", "--force", DB], { stdio: "inherit" });
  execFileSync(bin("createdb"), [DB], { stdio: "inherit" });
  const files = [
    join(repo, "db/test/auth_stub.sql"),
    ...readdirSync(join(repo, "db/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => join(repo, "db/migrations", f)),
  ];
  for (const file of files) {
    execFileSync(bin("psql"), ["-q", "-v", "ON_ERROR_STOP=1", "-d", DB, "-f", file], { stdio: ["ignore", "ignore", "inherit"] });
  }
  process.env.TEST_DATABASE_URL ??= `postgresql://localhost/${DB}`;
}

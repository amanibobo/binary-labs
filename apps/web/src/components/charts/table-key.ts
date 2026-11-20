import type { Sha256 } from "@/lib/ids";

// The query key a file's parsed tables are cached under, shared by every chart that reads them.
export const tableKey = (sha: Sha256) => ["data-table", sha] as const;

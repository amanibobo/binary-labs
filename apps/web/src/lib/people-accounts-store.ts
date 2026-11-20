import "server-only";
import type { LabId } from "./ids";
import { PeopleAccountsJson, type PersonAccount } from "./people-accounts";
import { unwrap, type Supabase } from "./supabase/server";

// The lab's People with the account each is linked to (lab_people, 0042), as the member reads
// it under their own session.
export async function loadPeopleAccounts(supabase: Supabase, labId: LabId): Promise<PersonAccount[]> {
  return PeopleAccountsJson.parse(unwrap(await supabase.rpc("lab_people", { p_lab_id: labId })));
}

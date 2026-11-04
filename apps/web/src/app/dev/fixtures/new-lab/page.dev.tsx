import { NewLabView } from "@/app/new-lab/new-lab-view";
import { requireFixtures } from "@/fixtures/gate";

export default function NewLabFixture() {
  requireFixtures();
  return <NewLabView email="a.okafor@university.edu" />;
}

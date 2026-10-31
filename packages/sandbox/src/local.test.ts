import { describeSandboxConformance } from "./conformance";
import { LocalSandboxDriver } from "./drivers/local";

describeSandboxConformance("local", () => new LocalSandboxDriver());

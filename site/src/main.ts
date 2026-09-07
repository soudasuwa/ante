// The whole script. No node connection, no delegate, no @ante/client — this
// page only explains things, so it should cost a visitor nothing to open and
// have no way to fail.
//
// The addresses come from the repo's deployments.json at BUILD time. They are
// never read from the URL: a parameter that could repoint them would let a
// crafted link show attacker data under a genuine address.

import "./style.css";
import deployments from "../../deployments.json";

const site = (name: "vault" | "guestbook") => deployments.sites[name].contract;

for (const name of ["vault", "guestbook"] as const) {
  const contract = site(name);
  const link = document.getElementById(`link-${name}`) as HTMLAnchorElement | null;
  const addr = document.getElementById(`addr-${name}`);
  if (link) link.href = `/v1/contract/web/${contract}/`;
  if (addr) addr.textContent = contract;
}

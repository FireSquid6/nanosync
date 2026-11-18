import { Electroview } from "electrobun/view";
import type { SpikeRPC } from "./rpc";

const rpc = Electroview.defineRPC<SpikeRPC>({
  maxRequestTime: Infinity,
  handlers: {},
});
new Electroview({ rpc });
const status = document.querySelector<HTMLOutputElement>("output")!;
for (const action of ["hide", "picker", "open", "quit"] as const) {
  document.getElementById(action)!.addEventListener("click", async () => {
    try {
      status.textContent = await rpc.request.action(action);
    } catch (error) {
      status.textContent = String(error);
    }
  });
}

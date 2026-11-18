export type SpikeRPC = {
  bun: {
    requests: {
      action: { params: "hide" | "picker" | "open" | "quit"; response: string };
    };
    messages: {};
  };
  webview: { requests: {}; messages: {} };
};

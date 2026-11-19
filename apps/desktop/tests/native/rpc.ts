export type FixtureRPC = {
  bun: {
    requests: {
      ready: { params: { port: number; id: number }; response: { ok: true } };
      echo: { params: null; response: { value: string } };
      syncFailure: { params: null; response: string };
      asyncFailure: { params: null; response: string };
      nonError: { params: null; response: string };
      rendererMalformedDone: { params: null; response: boolean };
      preloadObserved: { params: { logs: string[] }; response: boolean };
    };
    messages: {};
  };
  webview: {
    requests: {
      syncFailure: { params: null; response: string };
      asyncFailure: { params: null; response: string };
      report: { params: null; response: { href: string; socket: boolean; logs: string[] } };
      popup: { params: { url: string }; response: { denied: boolean; href: string } };
    };
    messages: { notice: { value: string } };
  };
};

import { expect, test } from "bun:test";
import { checkLocalDatabase } from "../src/selfcheck";

test("ClientLocal persists a head across close/reopen in a disposable directory", () => {
  expect(checkLocalDatabase()).toEqual({ sequence: 1, synchronous: 2 });
});

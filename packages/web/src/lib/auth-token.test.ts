// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { buildScreenWsUrl, getAuthToken } from "./auth-token";

function setLocation(url: string) {
  window.history.replaceState(null, "", url);
}

afterEach(() => {
  setLocation("/");
});

describe("getAuthToken", () => {
  it("URL の token を返す", () => {
    setLocation("/?token=abc");
    expect(getAuthToken()).toBe("abc");
  });

  it("無ければ null", () => {
    expect(getAuthToken()).toBeNull();
  });
});

describe("buildScreenWsUrl", () => {
  it("同一オリジンの ws URL を組み立てる", () => {
    expect(buildScreenWsUrl("s1")).toBe(
      `ws://${window.location.host}/screen/s1/ws`
    );
  });

  it("token があればクエリに載せる", () => {
    setLocation("/?token=a%26b");
    expect(buildScreenWsUrl("s1")).toBe(
      `ws://${window.location.host}/screen/s1/ws?token=a%26b`
    );
  });
});

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  systemPrefersDark = false;
});

// jsdom 没有实现 matchMedia，应用的主题 effect 依赖它；这里提供可在测试中切换的桩实现。
let systemPrefersDark = false;
const mediaListeners = new Set<(event: { matches: boolean }) => void>();

type MockMediaQueryList = {
  matches: boolean;
  media: string;
  onchange: null;
  addEventListener: (
    type: string,
    listener: (event: { matches: boolean }) => void,
  ) => void;
  removeEventListener: (
    type: string,
    listener: (event: { matches: boolean }) => void,
  ) => void;
  dispatchEvent: () => boolean;
  addListener: () => void;
  removeListener: () => void;
};

function matchMediaMock(query: string): MockMediaQueryList {
  return {
    get matches() {
      return query.includes("dark") && systemPrefersDark;
    },
    media: query,
    onchange: null,
    addEventListener(_type, listener) {
      mediaListeners.add(listener);
    },
    removeEventListener(_type, listener) {
      mediaListeners.delete(listener);
    },
    dispatchEvent() {
      return false;
    },
    addListener() {},
    removeListener() {},
  };
}

window.matchMedia = matchMediaMock as unknown as typeof window.matchMedia;

export function setSystemPrefersDark(value: boolean): void {
  systemPrefersDark = value;
  const event = { matches: value };
  mediaListeners.forEach((listener) => listener(event));
}

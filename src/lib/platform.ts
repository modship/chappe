const ua = navigator.userAgent;

export const platform: "mac" | "windows" | "linux" = ua.includes("Mac")
  ? "mac"
  : ua.includes("Windows")
    ? "windows"
    : "linux";

export const isMac = platform === "mac";

// Applied before the first paint, without an inline script (the content security policy forbids them).
try {
  const theme = localStorage.getItem("theme");
  const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
} catch {
  document.documentElement.classList.add("dark");
}
// The popup of the browser extension has a fixed size.
if (new URLSearchParams(location.search).has("popup")) document.documentElement.classList.add("popup");

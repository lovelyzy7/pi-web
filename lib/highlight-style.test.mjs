import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  conflictingShorthandGroups,
  isPlainColorValue,
  prepareHighlightTheme,
  splitConflictingShorthands,
} = await jiti.import("./highlight-style.ts");

// The package ships CommonJS; createRequire keeps the test free of a bundler.
const { createRequire } = await import("node:module");
// These are Babel-compiled CommonJS: the style object sits behind `default`.
const prismStyle = (file) => {
  const loaded = createRequire(import.meta.url)(`react-syntax-highlighter/dist/cjs/styles/prism/${file}.js`);
  return loaded.default ?? loaded;
};
const vs = prismStyle("vs");
const vscDarkPlus = prismStyle("vsc-dark-plus");

test("detects the shorthand/longhand pairs React warns about", () => {
  assert.deepEqual(conflictingShorthandGroups({ background: "#fff", backgroundColor: "#fff" }), ["background"]);
  assert.deepEqual(conflictingShorthandGroups({ overflow: "auto", overflowX: "auto" }), ["overflow"]);
  assert.deepEqual(conflictingShorthandGroups({ padding: "0 4px", paddingTop: 0 }), ["padding"]);
  assert.deepEqual(conflictingShorthandGroups({ border: "1px solid #ddd", borderWidth: 1 }), ["border"]);
  assert.deepEqual(conflictingShorthandGroups({ background: "#fff", padding: 4 }), []);
});

test("classifies colours separately from compound background values", () => {
  assert.equal(isPlainColorValue("#1e1e1e"), true);
  assert.equal(isPlainColorValue("var(--bg)"), true);
  assert.equal(isPlainColorValue("color-mix(in srgb, var(--bg) 92%, var(--bg-panel))"), true);
  assert.equal(isPlainColorValue("rgb(20, 20, 20)"), true);

  assert.equal(isPlainColorValue("url(assets/grain.svg)"), false);
  assert.equal(isPlainColorValue("linear-gradient(#000, #fff)"), false);
  assert.equal(isPlainColorValue("#fff center / cover no-repeat"), false);
});

test("splits backgrounds, boxes and borders into longhands", () => {
  assert.deepEqual(splitConflictingShorthands({ background: "white" }), { backgroundColor: "white" });
  assert.deepEqual(splitConflictingShorthands({ background: "url(x.png)" }), { background: "url(x.png)" });

  assert.deepEqual(splitConflictingShorthands({ padding: ".1em .3em" }), {
    paddingTop: ".1em",
    paddingRight: ".3em",
    paddingBottom: ".1em",
    paddingLeft: ".3em",
  });

  assert.deepEqual(splitConflictingShorthands({ border: "1px solid #dddddd" }), {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#dddddd",
  });

  assert.deepEqual(splitConflictingShorthands({ borderTop: "#ccc dashed 2px" }), {
    borderTopWidth: "2px",
    borderTopStyle: "dashed",
    borderTopColor: "#ccc",
  });

  assert.deepEqual(splitConflictingShorthands({ overflow: "auto" }), { overflowX: "auto", overflowY: "auto" });

  // Values it cannot parse stay untouched rather than changing the rendering.
  assert.deepEqual(splitConflictingShorthands({ border: "1px" }), { border: "1px" });
  assert.deepEqual(splitConflictingShorthands({ padding: "1px 2px 3px 4px 5px" }), { padding: "1px 2px 3px 4px 5px" });
  assert.deepEqual(splitConflictingShorthands({ marginTop: 4 }), { marginTop: 4 });
});

test("an existing longhand wins over the shorthand it came with", () => {
  assert.deepEqual(splitConflictingShorthands({ padding: "1px", paddingLeft: "9px" }), {
    paddingTop: "1px",
    paddingRight: "1px",
    paddingBottom: "1px",
    paddingLeft: "9px",
  });
});

test("the real Prism themes come out conflict-free", () => {
  for (const [name, theme] of [["vs", vs], ["vscDarkPlus", vscDarkPlus]]) {
    const prepared = prepareHighlightTheme(theme);
    for (const [selector, style] of Object.entries(prepared)) {
      assert.deepEqual(conflictingShorthandGroups(style), [], `${name} ${selector}`);
    }
    // The palettes' pre background survives as a colour.
    const pre = Object.entries(prepared).find(([selector]) => selector.startsWith("pre["))?.[1];
    assert.ok(pre, `${name} has a pre node`);
    assert.equal(typeof pre.backgroundColor, "string");
    assert.equal(pre.background, undefined);
  }
  assert.ok(vscDarkPlus['pre[class*="language-"]'].background, "the dark theme does use the shorthand");
});

test("preparing a theme is memoized so React sees stable objects", () => {
  assert.equal(prepareHighlightTheme(vs), prepareHighlightTheme(vs));
  assert.notEqual(prepareHighlightTheme(vs), prepareHighlightTheme(vscDarkPlus));
});

/** The object literal a `splitConflictingShorthands({ … })` call wraps. */
function literalAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} is used`);
  const end = source.indexOf("});", start);
  assert.notEqual(end, -1, `${marker} closes`);
  return source.slice(start + marker.length, end);
}

test("both highlighting components use the prepared styles", async () => {
  const cases = [
    {
      name: "components/MermaidBlock.tsx",
      source: await readFile(new URL("../components/MermaidBlock.tsx", import.meta.url), "utf8"),
      customStyle: "CODE_CUSTOM_STYLE",
      marker: "const CODE_CUSTOM_STYLE = splitConflictingShorthands({",
    },
    {
      name: "components/FileViewer.tsx",
      source: await readFile(new URL("../components/FileViewer.tsx", import.meta.url), "utf8"),
      customStyle: "preparedCustomStyle",
      marker: "const preparedCustomStyle = useMemo(() => splitConflictingShorthands({",
    },
  ];

  for (const { name, source, customStyle, marker } of cases) {
    // The raw theme objects would put `background` next to `backgroundColor`.
    assert.doesNotMatch(source, /style=\{isDark \? vscDarkPlus : vs\}/, name);
    assert.match(source, /style=\{isDark \? HIGHLIGHT_THEME_DARK : HIGHLIGHT_THEME_LIGHT\}/, name);
    assert.match(source, /prepareHighlightTheme\(vs\)/, name);
    assert.match(source, /prepareHighlightTheme\(vscDarkPlus\)/, name);

    // Our own override goes through the splitter and is handed to the highlighter.
    assert.match(source, new RegExp(`customStyle=\\{${customStyle}\\}`), name);
    const literal = literalAfter(source, marker);
    assert.doesNotMatch(literal, /\bbackground:/, `${name} customStyle must not use the shorthand`);
    assert.match(literal, /backgroundColor:/, name);
  }
});

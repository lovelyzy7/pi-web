/**
 * React refuses to mix a CSS shorthand with its longhands for the same value on
 * one element. When a rerender has to remove the longhand while the shorthand is
 * set (or the other way round) it logs:
 *
 *   Removing a style property during rerender (backgroundColor) when a
 *   conflicting property is set (background) can lead to styling bugs.
 *
 * react-syntax-highlighter's Prism themes do exactly that: `vs` styles
 * `pre[class*="language-"]` with `backgroundColor: "white"` while `vscDarkPlus`
 * uses `background: "#1e1e1e"`, and both land on the same `<pre>` element our
 * `customStyle` also styles. Switching the palette — or any rerender that swaps
 * the theme object — then mixes the two forms on one node.
 *
 * `splitConflictingShorthands` rewrites a style map so every group is expressed
 * with longhands, and `prepareHighlightTheme` applies that to every node of a
 * syntax-highlighter theme. Unknown or unparseable shorthand values are kept
 * as-is: a wrong expansion would change how the code block looks, which is worse
 * than the warning.
 */

/** Whitespace that is not inside parentheses separates shorthand components. */
function hasTopLevelWhitespace(value: string): boolean {
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(character)) return true;
  }
  return false;
}

/**
 * True for a value that is only a colour.
 *
 * `background` is a shorthand: `url(...)`, `linear-gradient(...)`, or
 * `#fff center / cover no-repeat` cannot be expressed as `background-color`.
 * A single colour token or a colour function (including `var()` and
 * `color-mix()`) can.
 */
export function isPlainColorValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  // `linear-gradient(` must be caught too, so the prefix may not be a letter only.
  if (/(^|[^a-z])(url|image|element|gradient|paint)\(/i.test(trimmed)) return false;
  if (/^(inherit|initial|unset|revert|transparent|currentcolor)$/i.test(trimmed)) return true;
  // A colour function may contain spaces inside its parentheses, never outside.
  return !hasTopLevelWhitespace(trimmed);
}

/** `1px solid #ddd` in any order → the three longhands, or null when unsure. */
function parseBorderShorthand(value: string): Record<string, string> | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const style = parts.find((part) => /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/.test(part));
  const width = parts.find((part) => /^(\d*\.?\d+(px|em|rem|pt|%)?|thin|medium|thick)$/.test(part));
  const color = parts.find((part) => part !== style && part !== width);
  if (!style || !width || !color) return null;
  return { width, style, color };
}

/** Up to four `padding`/`margin` values → the four longhands. */
function parseBoxShorthand(value: string): [string, string, string, string] | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > 4) return null;
  const [top, right = top, bottom = top, left = right] = parts;
  return [top, right, bottom, left];
}

const BORDER_SIDES: Record<string, string> = {
  borderTop: "Top",
  borderRight: "Right",
  borderBottom: "Bottom",
  borderLeft: "Left",
};

type StyleMap = Record<string, unknown>;

/** Rewrites one style map in place so shorthand groups become longhands. */
function splitMap(style: StyleMap): StyleMap {
  const source: StyleMap = { ...style };

  if (typeof source.background === "string" && isPlainColorValue(source.background)) {
    if (source.backgroundColor === undefined) source.backgroundColor = source.background;
    delete source.background;
  }

  if (typeof source.overflow === "string") {
    const value = source.overflow;
    source.overflowX ??= value;
    source.overflowY ??= value;
    delete source.overflow;
  }

  for (const [shorthand, longhands] of [
    ["padding", ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]],
    ["margin", ["marginTop", "marginRight", "marginBottom", "marginLeft"]],
  ] as const) {
    const value = source[shorthand];
    if (typeof value !== "string") continue;
    const parts = parseBoxShorthand(value);
    if (!parts) continue;
    longhands.forEach((longhand, index) => {
      source[longhand] ??= parts[index];
    });
    delete source[shorthand];
  }

  const border = typeof source.border === "string" ? parseBorderShorthand(source.border) : null;
  if (border) {
    source.borderWidth ??= border.width;
    source.borderStyle ??= border.style;
    source.borderColor ??= border.color;
    delete source.border;
  }
  for (const [shorthand, suffix] of Object.entries(BORDER_SIDES)) {
    const value = source[shorthand];
    if (typeof value !== "string") continue;
    const parsed = parseBorderShorthand(value);
    if (!parsed) continue;
    source[`border${suffix}Width`] ??= parsed.width;
    source[`border${suffix}Style`] ??= parsed.style;
    source[`border${suffix}Color`] ??= parsed.color;
    delete source[shorthand];
  }

  return source;
}

/** A style map with every shorthand group expressed as longhands. */
export function splitConflictingShorthands<T extends object>(style: T): T {
  return splitMap(style as StyleMap) as T;
}

const themeCache = new WeakMap<object, object>();

/**
 * The same for a whole syntax-highlighter theme: every node is a style map keyed
 * by a CSS selector. Memoized, so the objects React receives keep their identity
 * across renders.
 */
export function prepareHighlightTheme<T extends Record<string, object>>(theme: T): T {
  const cached = themeCache.get(theme) as T | undefined;
  if (cached) return cached;
  const prepared = Object.fromEntries(
    Object.entries(theme).map(([selector, style]) => [selector, splitMap(style as StyleMap)]),
  ) as T;
  themeCache.set(theme, prepared);
  return prepared;
}

/**
 * Shorthand properties and the longhands React treats as conflicting with them.
 * Only these groups produce the rerender warning.
 */
export const SHORTHAND_GROUPS: { shorthand: string; longhands: string[] }[] = [
  { shorthand: "background", longhands: ["backgroundColor"] },
  { shorthand: "overflow", longhands: ["overflowX", "overflowY"] },
  { shorthand: "padding", longhands: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] },
  { shorthand: "margin", longhands: ["marginTop", "marginRight", "marginBottom", "marginLeft"] },
  { shorthand: "border", longhands: ["borderWidth", "borderStyle", "borderColor"] },
  { shorthand: "borderTop", longhands: ["borderTopWidth", "borderTopStyle", "borderTopColor"] },
  { shorthand: "borderRight", longhands: ["borderRightWidth", "borderRightStyle", "borderRightColor"] },
  { shorthand: "borderBottom", longhands: ["borderBottomWidth", "borderBottomStyle", "borderBottomColor"] },
  { shorthand: "borderLeft", longhands: ["borderLeftWidth", "borderLeftStyle", "borderLeftColor"] },
];

/**
 * The shorthand groups a style map mixes with their longhands, for callers that
 * want a failure in a test rather than a warning in the browser console.
 */
export function conflictingShorthandGroups(style: object): string[] {
  return SHORTHAND_GROUPS
    .filter(({ shorthand, longhands }) => shorthand in style && longhands.some((longhand) => longhand in style))
    .map(({ shorthand }) => shorthand);
}

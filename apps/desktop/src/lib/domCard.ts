/** Small DOM-builder helper shared by the off-screen share cards
 *  (`exportComparison`, `exportBenchmarkCard`) that get rasterized via
 *  html-to-image. */
export function el(tag: string, style: Partial<CSSStyleDeclaration>, text?: string): HTMLElement {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text != null) node.textContent = text;
  return node;
}

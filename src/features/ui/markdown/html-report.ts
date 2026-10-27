/** Apply Markdown cleanup only outside HTML fences, including a streaming partial fence. */
export function mapOutsideHtmlReports(content: string, transform: (text: string) => string): string {
  return content.split(/(```html[^\n]*\n[\s\S]*?(?:```|$)|~~~html[^\n]*\n[\s\S]*?(?:~~~|$))/gi)
    .map((part, index) => index % 2 ? part : transform(part)).join("");
}

/** Build an inert, standalone report for preview and download, never application HTML. */
export function buildHtmlReport(source: string): string {
  // Template contents are inert even while parsing (DOMParser may fetch images).
  const document = window.document.implementation.createHTMLDocument("");
  const template = document.createElement("template");
  template.innerHTML = source;
  document.documentElement.lang = "ja";
  const allowed = new Set("html head body title meta style main header footer section article aside nav div span p br hr h1 h2 h3 h4 h5 h6 strong em b i u s small sub sup blockquote pre code ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td a img figure figcaption details summary".split(" "));
  const attributes = new Set("class id style title lang dir colspan rowspan scope width height open start reversed".split(" "));
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    const tag = element.tagName.toLowerCase();
    if (!allowed.has(tag) || tag === "meta") { element.remove(); continue; }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const safeLink = tag === "a" && name === "href" && /^https?:\/\//i.test(attribute.value.trim());
      const safeImage = tag === "img" && name === "src" && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(attribute.value.trim());
      if (!attributes.has(name) && !safeLink && !safeImage && !(tag === "img" && name === "alt")) element.removeAttribute(attribute.name);
    }
    if (tag === "a") { element.setAttribute("target", "_blank"); element.setAttribute("rel", "noopener noreferrer"); }
  }
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const charset = document.createElement("meta"); charset.setAttribute("charset", "utf-8");
  document.head.prepend(policy); document.head.prepend(charset);
  const viewport = document.createElement("meta"); viewport.name = "viewport"; viewport.content = "width=device-width, initial-scale=1"; document.head.append(viewport);
  const style = document.createElement("style");
  style.textContent = "body{font-family:system-ui,sans-serif;line-height:1.6;padding:24px;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%}th,td{border:1px solid #ccc;padding:8px}img{max-width:100%}@media print{body{padding:0}}";
  document.head.append(style);
  document.body.append(template.content);
  return "<!doctype html>\n" + document.documentElement.outerHTML;
}

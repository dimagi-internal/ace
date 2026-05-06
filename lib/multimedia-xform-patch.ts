//
// Pure XML transformation: given a CommCare XForm and a list of
// (fieldId, cczFilename) pairs, add a `<value form="image">jr://...</value>`
// child to the matching `<text id="<fieldId>-label">` node in itext.
// Idempotent: skips fields whose <image> value is already present.
//
// Why this exists: CCHQ's `clean_paths()` prunes any uploaded multimedia
// binary that no form references on the next `make_build`. Without this
// XML patch, uploaded PNGs are silently lost. The patch is the load-bearing
// step that causes CCHQ to retain the asset in the released CCZ.
//

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

export interface ImageBinding {
  fieldId: string;
  cczFilename: string;
}

export interface PatchResult {
  patched: boolean;
  xml: string;
  applied: string[]; // field ids that were modified
  skipped: string[]; // field ids whose itext was already up-to-date
  notFound: string[]; // field ids with no matching itext text
}

export interface AddImageItextOptions {
  /**
   * If true, strip any existing `<value form="image">` children from the
   * matching itext text node before adding the new one. Default `false`
   * preserves append-only idempotency on identical URLs.
   *
   * Use this when re-running the multimedia-coverage skill on a form that
   * already has an attached image with a different filename — without it,
   * CCHQ's build validator rejects with `duplicate definition for text ID
   * '<field>-label' and form 'image'`.
   */
  replaceExisting?: boolean;
}

export function addImageItext(
  xml: string,
  bindings: ImageBinding[],
  options?: AddImageItextOptions,
): PatchResult {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const applied: string[] = [];
  const skipped: string[] = [];
  const notFound: string[] = [];
  const replaceExisting = options?.replaceExisting === true;

  // Find every <text id="..."> node anywhere; loose match handles
  // multi-translation forms (each <translation lang="..."> has its own copy).
  const texts = Array.from(doc.getElementsByTagName('text'));

  for (const b of bindings) {
    const targetId = `${b.fieldId}-label`;
    const matches = texts.filter((t) => t.getAttribute('id') === targetId);
    if (matches.length === 0) {
      notFound.push(b.fieldId);
      continue;
    }

    const jrUrl = `jr://file/commcare/image/${b.cczFilename}`;
    let modifiedThisField = false;
    for (const t of matches) {
      if (replaceExisting) {
        Array.from(t.getElementsByTagName('value'))
          .filter((v) => v.getAttribute('form') === 'image')
          .forEach((v) => {
            v.parentNode?.removeChild(v);
            modifiedThisField = true;
          });
      }

      const existing = Array.from(t.getElementsByTagName('value')).some(
        (v) => v.getAttribute('form') === 'image' && (v.textContent ?? '').trim() === jrUrl,
      );
      if (existing) continue;

      const valueEl = doc.createElement('value');
      valueEl.setAttribute('form', 'image');
      valueEl.appendChild(doc.createTextNode(jrUrl));
      t.appendChild(valueEl);
      modifiedThisField = true;
    }

    if (modifiedThisField) applied.push(b.fieldId);
    else skipped.push(b.fieldId);
  }

  const out = new XMLSerializer().serializeToString(doc);
  return { patched: applied.length > 0, xml: out, applied, skipped, notFound };
}

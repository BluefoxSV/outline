import { Node } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import Extension from "../lib/Extension";

const pluginKey = new PluginKey("bluefoxHideTmp002");

function nodeText(node: Node): string {
  let out = "";
  node.descendants((child) => {
    if (child.isText) {
      out += child.text || "";
    }
    return true;
  });
  return out;
}

function isTmp002Heading(node: Node): boolean {
  if (node.type.name !== "heading") {
    return false;
  }
  const t = nodeText(node).toLowerCase();
  return t.includes("tmp-002") || t.includes("document metadata");
}

function isMetaKeyValueTable(node: Node): boolean {
  if (node.type.name !== "table") {
    return false;
  }
  const t = nodeText(node).toLowerCase();
  return (
    t.includes("status") &&
    (t.includes("mkdocs path") || t.includes("mkdocs_path") || t.includes("id"))
  );
}

/**
 * Hide the leading TMP-002 heading + Key|Value table in the editor.
 * Metadata lives in documents.bluefoxMeta; authors should not see/edit the table.
 */
export default class BluefoxHideTmp002 extends Extension {
  get name() {
    return "bluefox_hide_tmp002";
  }

  get plugins() {
    return [
      new Plugin({
        key: pluginKey,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const { doc } = state;
            let i = 0;
            const kids = doc.content;
            while (i < kids.childCount) {
              const child = kids.child(i);
              if (isTmp002Heading(child)) {
                let pos = 0;
                for (let j = 0; j < i; j++) {
                  pos += kids.child(j).nodeSize;
                }
                decorations.push(
                  Decoration.node(pos, pos + child.nodeSize, {
                    class: "bluefox-tmp002-hidden",
                  })
                );
                // Hide following blank paragraphs then the meta table
                let k = i + 1;
                let p = pos + child.nodeSize;
                while (k < kids.childCount) {
                  const next = kids.child(k);
                  if (
                    next.type.name === "paragraph" &&
                    nodeText(next).trim() === ""
                  ) {
                    decorations.push(
                      Decoration.node(p, p + next.nodeSize, {
                        class: "bluefox-tmp002-hidden",
                      })
                    );
                    p += next.nodeSize;
                    k++;
                    continue;
                  }
                  if (isMetaKeyValueTable(next)) {
                    decorations.push(
                      Decoration.node(p, p + next.nodeSize, {
                        class: "bluefox-tmp002-hidden",
                      })
                    );
                  }
                  break;
                }
                break;
              }
              // Table-only TMP-002 at doc start (no heading)
              if (i === 0 && isMetaKeyValueTable(child)) {
                decorations.push(
                  Decoration.node(0, child.nodeSize, {
                    class: "bluefox-tmp002-hidden",
                  })
                );
                break;
              }
              // Stop scanning after first non-empty non-meta block
              if (
                !(
                  child.type.name === "paragraph" &&
                  nodeText(child).trim() === ""
                )
              ) {
                break;
              }
              i++;
            }
            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  }
}

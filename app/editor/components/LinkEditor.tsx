import { ArrowIcon, CloseIcon, DocumentIcon, OpenIcon } from "outline-icons";
import { Mark } from "prosemirror-model";
import { Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import * as React from "react";
import { toast } from "sonner";
import styled from "styled-components";
import { s } from "@shared/styles";
import { isInternalUrl, sanitizeUrl } from "@shared/utils/urls";
import Flex from "~/components/Flex";
import { Dictionary } from "~/hooks/useDictionary";
import useStores from "~/hooks/useStores";
import Document from "~/models/Document";
import Input from "./Input";
import ToolbarButton from "./ToolbarButton";
import Tooltip from "./Tooltip";

type Props = {
  mark?: Mark;
  from: number;
  to: number;
  dictionary: Dictionary;
  onRemoveLink?: () => void;
  onSelectLink: (options: {
    href: string;
    title?: string;
    from: number;
    to: number;
  }) => void;
  onClickLink: (
    href: string,
    event: React.MouseEvent<HTMLButtonElement>
  ) => void;
  view: EditorView;
};

function looksLikeUrl(value: string) {
  return /^(https?:\/\/|\/|#|mailto:)/i.test(value.trim());
}

export default function LinkEditor(props: Props) {
  const { documents } = useStores();
  const href = sanitizeUrl(props.mark?.attrs.href) ?? "";
  const initialValue = href;
  const initialSelectionLength = props.to - props.from;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const discardRef = React.useRef(false);
  const valueRef = React.useRef(href);
  const [value, setValue] = React.useState(href);
  const [results, setResults] = React.useState<Document[]>([]);
  const [selectedIndex, setSelectedIndex] = React.useState(0);

  const save = React.useCallback(
    (nextHref: string, title?: string) => {
      const trimmed = nextHref.trim();
      if (!trimmed) {
        return;
      }
      discardRef.current = true;
      props.onSelectLink({
        href: sanitizeUrl(trimmed) ?? "",
        title,
        from: props.from,
        to: props.to,
      });
    },
    [props]
  );

  const moveSelectionToEnd = React.useCallback(() => {
    const { to, view } = props;
    const nextSelection = Selection.findFrom(
      view.state.tr.doc.resolve(to),
      1,
      true
    );
    if (nextSelection) {
      view.dispatch(view.state.tr.setSelection(nextSelection));
    }
    view.focus();
  }, [props]);

  const handleRemoveLink = React.useCallback(() => {
    discardRef.current = true;
    const { from, to, mark, view, onRemoveLink } = props;
    if (mark) {
      view.dispatch(view.state.tr.removeMark(from, to, mark));
    }
    onRemoveLink?.();
    view.focus();
  }, [props]);

  React.useEffect(() => {
    valueRef.current = value;
  }, [value]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "k" && event.metaKey) {
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (discardRef.current) {
        return;
      }
      const current = valueRef.current;
      if (current === initialValue) {
        return;
      }
      const next = current.trim();
      if (!next) {
        handleRemoveLink();
        return;
      }
      save(next, next);
    };
    // unmount-only; save/handleRemoveLink are stable enough for unmount flush
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed || looksLikeUrl(trimmed) || !props.view.editable) {
      setResults([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void documents
        .searchTitles({ query: trimmed, limit: 8 })
        .then((rows) => {
          if (!cancelled) {
            setResults(
              rows
                .map((row) => row.document)
                .filter((doc): doc is Document => !!doc)
            );
            setSelectedIndex(0);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
          }
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value, documents, props.view.editable]);

  const pickDocument = (doc: Document) => {
    save(`/doc/${doc.id}`, doc.titleWithDefault);
    if (initialSelectionLength) {
      moveSelectionToEnd();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown": {
        if (results.length) {
          event.preventDefault();
          setSelectedIndex((i) => (i + 1) % results.length);
        }
        return;
      }
      case "ArrowUp": {
        if (results.length) {
          event.preventDefault();
          setSelectedIndex((i) => (i - 1 + results.length) % results.length);
        }
        return;
      }
      case "Enter": {
        event.preventDefault();
        const picked = results[selectedIndex];
        if (picked && !looksLikeUrl(value)) {
          pickDocument(picked);
        } else {
          save(value, value);
          if (initialSelectionLength) {
            moveSelectionToEnd();
          }
        }
        return;
      }
      case "Escape": {
        event.preventDefault();
        if (initialValue) {
          setValue(initialValue);
          moveSelectionToEnd();
        } else {
          handleRemoveLink();
        }
        return;
      }
      default:
    }
  };

  const handleOpenLink = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    try {
      props.onClickLink(href, event);
    } catch (_err) {
      toast.error(props.dictionary.openLinkError);
    }
  };

  const { view, dictionary } = props;
  const isInternal = isInternalUrl(value);

  return (
    <Wrapper column>
      <Row>
        <Input
          ref={inputRef}
          value={value}
          placeholder={dictionary.searchOrPasteLink}
          onKeyDown={handleKeyDown}
          onPaste={() => {
            window.setTimeout(() => save(valueRef.current, valueRef.current), 0);
          }}
          onChange={(event) => {
            setValue(event.target.value);
            setSelectedIndex(0);
          }}
          autoFocus={href === ""}
          readOnly={!view.editable}
        />
        <Tooltip
          content={isInternal ? dictionary.goToLink : dictionary.openLink}
        >
          <ToolbarButton onClick={handleOpenLink} disabled={!value}>
            {isInternal ? <ArrowIcon /> : <OpenIcon />}
          </ToolbarButton>
        </Tooltip>
        {view.editable && (
          <Tooltip content={dictionary.removeLink}>
            <ToolbarButton onClick={handleRemoveLink}>
              <CloseIcon />
            </ToolbarButton>
          </Tooltip>
        )}
      </Row>
      {results.length > 0 ? (
        <Results>
          {results.map((doc, index) => (
            <ResultButton
              key={doc.id}
              type="button"
              $active={index === selectedIndex}
              onMouseEnter={() => setSelectedIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                pickDocument(doc);
              }}
            >
              <DocumentIcon />
              <ResultText>
                <span>{doc.titleWithDefault}</span>
                {doc.collection?.name ? (
                  <small>{doc.collection.name}</small>
                ) : null}
              </ResultText>
            </ResultButton>
          ))}
        </Results>
      ) : null}
    </Wrapper>
  );
}

const Wrapper = styled(Flex)`
  pointer-events: all;
  gap: 8px;
  width: 100%;
`;

const Row = styled(Flex)`
  gap: 8px;
  width: 100%;
`;

const Results = styled.div`
  max-height: 220px;
  overflow: auto;
  width: 100%;
  border-top: 1px solid ${s("inputBorder")};
`;

const ResultButton = styled.button<{ $active?: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  background: ${(props) =>
    props.$active ? props.theme.listItemHoverBackground : "transparent"};
  color: ${s("text")};
  text-align: left;
  padding: 6px 8px;
  cursor: pointer;
`;

const ResultText = styled.span`
  display: flex;
  flex-direction: column;
  min-width: 0;

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    color: ${s("textTertiary")};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

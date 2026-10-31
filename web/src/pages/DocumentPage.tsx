import { Link, useParams } from "react-router-dom";
import { get } from "../api";
import { Chip, LoadError, formatDate, Spinner, useLoad, usePageTitle } from "../components/ui";
import type { DocumentSummary } from "../types";

interface DocumentDetail extends DocumentSummary {
  sections: { heading: string; text: string; flagged: boolean }[];
}

/** Authorized, read-only view of an indexed document (the text the assistant cites). */
export function DocumentPage() {
  const { projectId, docId } = useParams();
  const { data: doc, error, loading } = useLoad(() => get<DocumentDetail>(`/api/projects/${projectId}/documents/${docId}`), [projectId, docId]);
  usePageTitle(doc?.name ?? "Document");
  if (loading && !doc) return <Spinner label="Loading document" />;
  if (error) return <LoadError error={error} what="document" />;
  if (!doc) return null;
  const isReal = doc.webUrl.startsWith("https://");
  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Source document</span>
          <h1>{doc.name}</h1>
          <div className="row small muted">
            <span>{doc.docType.replace("_", " ")}</span>
            {doc.versionLabel && <span>Version {doc.versionLabel}</span>}
            <span>Updated {formatDate(doc.lastModifiedAt)}</span>
            {!isReal && <Chip tone="neutral">Mock SharePoint copy</Chip>}
          </div>
        </div>
        <div className="row">
          {isReal && <a className="btn" href={doc.webUrl} target="_blank" rel="noreferrer">Open in SharePoint</a>}
          <Link className="btn" to={`/projects/${projectId}`}>Back to project</Link>
        </div>
      </div>
      <article className="reading prose" style={{ display: "grid", gap: 36 }}>
        {doc.sections.map((s, i) => (
          <div className="doc-section" key={i}>
            {s.heading && <h3>{s.heading}</h3>}
            {s.flagged ? (
              <div className="alert alert-warn small">This passage contains instruction-like text aimed at AI systems. It is withheld from the assistant and shown here for review only.</div>
            ) : null}
            <p>{s.text}</p>
          </div>
        ))}
      </article>
    </>
  );
}

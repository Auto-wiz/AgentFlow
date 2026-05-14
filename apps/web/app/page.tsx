import Link from "next/link";
import { getGhlInstallUrl } from "../lib/ghl-install-url";

export default function HomePage() {
  const goHighLevelConnectUrl = getGhlInstallUrl();

  return (
    <section className="module-shell">
      <div className="panel" style={{ padding: 22 }}>
        <p className="eyebrow">Overview</p>
        <h2 style={{ marginTop: 8 }}>Agency workspace shell</h2>
        <p className="muted">
          Esta vista replica la estructura general del dashboard (filtros + módulos). El módulo
          principal activo hoy es Inbox.
        </p>
        <div className="badge-row" style={{ marginTop: 14 }}>
          <span className="badge">Inbox listo</span>
          <span className="badge">Appointments listo</span>
          <span className="badge">Subaccounts listo</span>
          <span className="badge">Módulos extra en progreso</span>
        </div>
      </div>

      <div className="placeholder-grid">
        <article className="placeholder-card">
          <p className="eyebrow">Conversations</p>
          <strong>Inbox module</strong>
          <p className="muted">Vista principal estilo GHL con filtros, lista, chat y contacto.</p>
          <Link className="button secondary" href="/threads">
            Open inbox
          </Link>
        </article>
        <article className="placeholder-card">
          <p className="eyebrow">Revenue</p>
          <strong>Pipeline metrics</strong>
          <p className="muted">Placeholder visual para cards de oportunidad/valor.</p>
        </article>
        <article className="placeholder-card">
          <p className="eyebrow">Automation</p>
          <strong>Workflow snapshots</strong>
          <p className="muted">Placeholder para módulos que se conectarán luego.</p>
        </article>
      </div>

      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Connections</p>
        <h3 style={{ marginTop: 8 }}>GoHighLevel install</h3>
        <p className="muted">Conecta nuevas subaccounts desde el marketplace.</p>
        <div className="badge-row" style={{ marginTop: 10 }}>
          <a className="button secondary" href={goHighLevelConnectUrl}>
            Connect GoHighLevel
          </a>
        </div>
      </div>
    </section>
  );
}

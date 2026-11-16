import { useAdmin } from "../state/AdminContext";

export function ActivityPage() {
  const { activity } = useAdmin();
  return (
    <section className="nv-panel nv-stack">
      <h2>Recent activity</h2>
      {activity.map((entry) => <article key={entry.sequence}>
        <strong>{entry.action}</strong>
        <p>{entry.origin} · <time dateTime={new Date(entry.occurredAtMs).toISOString()}>
          {new Date(entry.occurredAtMs).toLocaleString()}
        </time></p>
        <p>{entry.targetId}</p>
      </article>)}
    </section>
  );
}

import Fuse from 'fuse.js';
export type SearchDocument = { slug: string; title: string; content: string };
export function createDocSearch(documents: SearchDocument[]) {
  const index = new Fuse(documents, { keys: [{ name: 'title', weight: 2 }, 'content'], threshold: 0.35, ignoreLocation: true });
  return (query: string) => query.trim() ? index.search(query.trim()).map(result => result.item) : [];
}

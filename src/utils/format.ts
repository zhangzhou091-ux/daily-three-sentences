export const getSafeTags = (tags: unknown): string[] => {
  if (tags === null || tags === undefined) return [];

  if (Array.isArray(tags)) {
    return tags.map(String).filter(tag => tag.trim() !== '');
  }

  return String(tags)
    .split(/[，,;；]/)
    .map(t => t.trim())
    .filter(t => t !== '');
};

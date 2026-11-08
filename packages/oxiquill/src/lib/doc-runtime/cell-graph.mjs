/**
 * @template {{ id: string, dependsOn?: Readonly<Record<string, {cell: string}>> }} Cell
 * @param {readonly Cell[]} cells
 * @param {readonly string[]} roots
 * @returns {Cell[]}
 */
export function dependencyOrder(cells, roots) {
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const visited = new Set();
  const visiting = new Set();
  const result = [];
  const visit = (id) => {
    if (visited.has(id)) return;
    const cell = byId.get(id);
    if (!cell) throw new Error(`Unknown dependency cell ${id}`);
    if (visiting.has(id)) throw new Error(`Cyclic data dependency at ${id}`);
    visiting.add(id);
    [...new Set(Object.values(cell.dependsOn ?? {}).map((dependency) => dependency.cell))].sort().forEach(visit);
    visiting.delete(id);
    visited.add(id);
    result.push(cell);
  };
  [...new Set(roots)].sort().forEach(visit);
  return result;
}

/**
 * @param {readonly {id: string, dependsOn?: Readonly<Record<string, {cell: string}>>}[]} cells
 * @param {string} id
 * @returns {readonly string[]}
 */
export function dependentIds(cells, id) {
  const result = new Set();
  const visit = (parent) => {
    cells
      .filter((cell) => Object.values(cell.dependsOn ?? {}).some((dependency) => dependency.cell === parent))
      .forEach((cell) => {
        if (result.has(cell.id)) return;
        result.add(cell.id);
        visit(cell.id);
      });
  };
  visit(id);
  return [...result].sort();
}

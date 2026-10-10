// Shared by browser charts and static Python figures. Both chart backgrounds
// meet the contrast budget with this fixed sequence; do not interpolate colors.
export const chartPalette = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767'
] as const;

export const heatmapPalette = {
  light: ['#d9f2f0', '#0f766e'],
  dark: ['#12312f', '#53d3c9']
} as const;

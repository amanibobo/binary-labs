// A demo lab's data is made up (decisions.md, "Sample on demo data"). Anything that can leave
// the app from one says so: a downloaded chart's title, a CSV's first line, an exported file.

export const SAMPLE_NOTE = "Sample data from a demo lab. Every name and number in it is made up.";

export function sampleTitle(title: string, demo: boolean): string {
  return demo ? `Sample data: ${title}` : title;
}

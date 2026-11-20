import { describe, expect, it } from "vitest";
import { fileName } from "@/components/charts/chart-export";
import { exportFileName } from "../lab-deletion";
import { sampleTitle } from "../sample";

describe("a demo lab's downloads", () => {
  it("lead with Sample data, and a real lab's are left alone", () => {
    expect(sampleTitle("Bradford standard curve", true)).toBe("Sample data: Bradford standard curve");
    expect(sampleTitle("Bradford standard curve", false)).toBe("Bradford standard curve");
  });

  it("carry the mark into the file's name", () => {
    expect(fileName(sampleTitle("Bradford standard curve", true), "png")).toBe("Sample data Bradford standard curve.png");
    expect(exportFileName(sampleTitle("Okafor Lab (demo)", true))).toBe("sample-data-okafor-lab-demo-protocols.md");
  });
});

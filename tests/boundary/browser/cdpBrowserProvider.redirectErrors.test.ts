import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import type { FakeOptions } from "../../fixtures/fakeCdpBrowserTypes.js";
import { describeBrowser, trackBrowser } from "./cdpBrowserProvider.support.js";

const inspectNetwork = async (options: FakeOptions) => {
  const browser = await startFakeCdpBrowser(options);
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );
  if (!result.ok) throw result.error;
  return { browser, inspection: result.value };
};

describeBrowser("CdpBrowserProvider: redirect errors", () => {
  it.each([
    { label: "missing", url: undefined, reason: "invalid_protocol_value" },
    { label: "malformed", url: "http://%", reason: "invalid_protocol_value" },
    {
      label: "unsupported scheme",
      url: "file:///private/redirect",
      reason: "unsupported_url",
    },
  ])("classifies $label redirect response URLs", async ({ url, reason }) => {
    const { inspection } = await inspectNetwork({
      malformedRedirectResponse: true,
      ...(url === undefined ? {} : { redirectResponseUrl: url }),
    });

    expect(inspection.network.requests).toEqual([]);
    expect(inspection.completeness.excluded).toContainEqual({
      section: "network_requests",
      reason,
      count: expect.any(Number),
    });
    const section =
      reason === "unsupported_url"
        ? inspection.completeness.policy_filtered_sections
        : inspection.completeness.unavailable_sections;
    expect(section).toContain("network_requests");
  });

  it.each([
    { label: "null", envelope: null },
    { label: "array", envelope: [] },
    { label: "scalar", envelope: "malformed redirect" },
  ])(
    "preserves prior request for a $label redirect envelope",
    async ({ envelope }) => {
      const { browser, inspection } = await inspectNetwork({
        malformedRedirectResponse: true,
        redirectResponseEnvelope: envelope,
      });

      expect(inspection.network.requests).toHaveLength(1);
      expect(inspection.network.requests[0]).toMatchObject({
        request_id: "request-1",
        url: `${browser.allowedOrigin}/api?token=network-secret`,
        redirects: [],
      });
      expect(inspection.completeness.unavailable_sections).toContain(
        "network_requests",
      );
      expect(inspection.completeness.excluded).toContainEqual({
        section: "network_requests",
        reason: "invalid_protocol_value",
        count: expect.any(Number),
      });
      expect(JSON.stringify(inspection.network.requests)).not.toContain(
        "malformed-redirect-final",
      );
    },
  );
});

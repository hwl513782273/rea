import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { describeBrowser, trackBrowser } from "./cdpBrowserProvider.support.js";

describeBrowser("CdpBrowserProvider: network 1", () => {
  it("retains same-origin redirect hops on the one final request", async () => {
    const browser = await startFakeCdpBrowser({ redirectWithinOrigin: true });
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
    expect(result.value.network.requests).toHaveLength(1);
    expect(result.value.network.requests[0]).toMatchObject({
      request_id: "request-1",
      url: `${browser.allowedOrigin}/redirected?token=final-secret`,
      status: 200,
      redirects: [
        {
          url: `${browser.allowedOrigin}/api?token=network-secret`,
          response_url: `${browser.allowedOrigin}/api?token=network-secret`,
          method: "POST",
          resource_type: "Fetch",
          status: 301,
          mime_type: "text/plain",
          encoded_data_length: 23,
          request_timestamp: 7,
          redirect_event_timestamp: 8,
        },
        {
          url: `${browser.allowedOrigin}/intermediate`,
          response_url: `${browser.allowedOrigin}/intermediate`,
          method: "GET",
          resource_type: "Fetch",
          status: 302,
          mime_type: "text/plain",
          encoded_data_length: 27,
          request_timestamp: 8,
          redirect_event_timestamp: 9,
        },
      ],
    });
    expect(JSON.stringify(result.value.network.requests)).not.toContain(
      "redirect-header-secret",
    );
  });

  it("drops network evidence when a request redirects outside the approved origin", async () => {
    const browser = await startFakeCdpBrowser({
      redirectToDisallowedOrigin: true,
    });
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
    expect(result.value.network.requests).toEqual([]);
  });

  it("does not retain excluded prior-hop data when a redirect returns in scope", async () => {
    const browser = await startFakeCdpBrowser({
      redirectFromDisallowedOrigin: true,
    });
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
    expect(result.value.network.requests).toHaveLength(1);
    expect(result.value.network.requests[0]).toMatchObject({
      url: `${browser.allowedOrigin}/returned`,
      redirects: [],
    });
    const output = JSON.stringify(result.value.network.requests);
    expect(output).not.toContain("private.example.test");
    expect(output).not.toContain("redirect-header-secret");
    expect(output).not.toContain("redirect-body-secret");
    expect(result.value.completeness.policy_filtered_sections).toContain(
      "network_requests",
    );
    expect(result.value.completeness.status).toBe("policy_filtered");
    expect(result.value.completeness.unavailable_sections).not.toContain(
      "network_requests",
    );
    expect(result.value.completeness.excluded).not.toContainEqual({
      section: "network_requests",
      reason: "invalid_protocol_value",
      count: expect.any(Number),
    });
  });

  it.each([
    { label: "missing", url: undefined, reason: "invalid_protocol_value" },
    { label: "malformed", url: "http://%", reason: "invalid_protocol_value" },
    {
      label: "unsupported scheme",
      url: "file:///private/redirect",
      reason: "unsupported_url",
    },
  ])(
    "classifies $label redirect response URLs accurately",
    async ({ url, reason }) => {
      const browser = await startFakeCdpBrowser({
        malformedRedirectResponse: true,
        ...(url === undefined ? {} : { redirectResponseUrl: url }),
      });
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
      expect(result.value.network.requests).toEqual([]);
      expect(result.value.completeness.excluded).toContainEqual({
        section: "network_requests",
        reason,
        count: expect.any(Number),
      });
      if (reason === "unsupported_url") {
        expect(result.value.completeness.policy_filtered_sections).toContain(
          "network_requests",
        );
        expect(result.value.completeness.unavailable_sections).not.toContain(
          "network_requests",
        );
      } else {
        expect(result.value.completeness.unavailable_sections).toContain(
          "network_requests",
        );
        expect(
          result.value.completeness.policy_filtered_sections,
        ).not.toContain("network_requests");
      }
    },
  );
});

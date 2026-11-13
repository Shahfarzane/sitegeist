# Proxy Architecture

## Overview

Sitegeist uses a **CORS Proxy** to handle Cross-Origin Resource Sharing restrictions for:

1. **LLM API calls** - When providers block direct browser requests
2. **Document extraction** - When websites block automated downloads from extensions

## Problem Statement

Browser extensions face CORS restrictions when making HTTP requests:

1. **LLM API Calls**: Some providers (Anthropic with OAuth tokens, Z-AI) have CORS headers that block direct browser requests
2. **Document Extraction**: Websites serving PDFs/DOCX files often have CORS policies that block automated downloads

Without a CORS proxy, these requests would fail in the browser environment.

## Current Implementation

### Architecture

```
┌─────────────┐
│   Browser   │
│  Extension  │
└──────┬──────┘
       │
       ├──────────────────────────────────────────────────┐
       │                                                  │
       v                                                  v
┌──────────────────┐                           ┌──────────────────┐
│ ProviderTransport │                          │ extract_document │
│ (LLM requests)    │                          │ (fetch docs)     │
└──────┬───────────┘                           └──────┬───────────┘
       │                                               │
       │  Load proxy settings                          │  Check corsProxyUrl
       │  from storage                                 │  property
       │                                               │
       v                                               v
   applyProxyIfNeeded()                         Try direct fetch first
       │                                               │
       │  Provider-specific logic:                     │
       │  - Z-AI: always proxy                         ├─ Success → Done
       │  - Anthropic sk-ant-oat: proxy                │
       │  - Others: no proxy                           ├─ CORS error + proxy
       │                                               │   configured?
       v                                               │
   If proxy needed:                                    v
   baseUrl = proxy/?url=...                     Retry with proxy
       │                                               │
       └───────────────────┬───────────────────────────┘
                           │
                           v
                  ┌────────────────┐
                  │  CORS Proxy    │
                  │  (strips CORS) │
                  └────────────────┘
```

### File Structure

#### Sitegeist (Extension)

- **`src/sidepanel.ts`**:
  - Lines 236-237: Loads proxy settings from storage
  - Lines 364-368: Configures `extract_document` tool with proxy URL if enabled
  - Lines 776-785: Initializes default proxy settings on first run

- **`src/tutorials.ts`**:
  - Line 90: Explains CORS proxy to users in welcome tutorial

#### pi-web-ui Package

- **`src/utils/proxy-utils.ts`**:
  - Centralized proxy decision logic
  - `shouldUseProxyForProvider(provider, apiKey)`: Returns true for Z-AI (always) and Anthropic with OAuth tokens (`sk-ant-oat-*`), false for others
  - `applyProxyIfNeeded(model, apiKey, proxyUrl)`: Applies proxy to model's baseUrl only if provider/key combination requires it
  - `isCorsError(error)`: Detects CORS errors by checking for `TypeError: Failed to fetch`, `NetworkError`, or messages containing "cors"/"cross-origin"

- **`src/agent/transports/ProviderTransport.ts`**:
  - Loads proxy settings from storage (`proxy.enabled`, `proxy.url`)
  - Uses `applyProxyIfNeeded()` to selectively apply proxy based on provider and API key
  - **Behavior**: Only Z-AI and Anthropic OAuth tokens use proxy; OpenAI, Google, Groq, OpenRouter, Cerebras, xAI, Ollama, LM Studio connect directly

- **`src/tools/extract-document.ts`**:
  - Tool has optional `corsProxyUrl` property set by Sitegeist if proxy is enabled
  - Implements try-first-fallback pattern:
    1. Attempts direct fetch to document URL
    2. If CORS error occurs and proxy is configured, retries with proxy
    3. If CORS error and no proxy, shows error message suggesting proxy configuration or manual download
    4. If non-CORS error, re-throws immediately
  - **Behavior**: Direct fetch preferred; proxy only used when CORS error occurs

- **`src/components/ProviderKeyInput.ts`**:
  - Uses `applyProxyIfNeeded()` when testing API keys
  - **Behavior**: Only Z-AI and Anthropic OAuth tokens test through proxy; others test directly

- **`src/dialogs/SettingsDialog.ts`** (ProxyTab):
  - Lines 50-119: UI for proxy configuration
  - Toggle switch to enable/disable proxy
  - Text input for proxy URL
  - Description explains it's required for Z-AI and Anthropic with OAuth token
  - Format hint shows proxy must accept `<proxy-url>/?url=<target-url>`
  - Saves to `storage.settings` with keys `proxy.enabled` and `proxy.url`

- **`src/agent/transports/proxy-types.ts`**:
  - Defines event types for `AppTransport` (alternative transport in pi-web-ui package)
  - Not used by Sitegeist - only `ProviderTransport` is used

- **`src/agent/transports/AppTransport.ts`**:
  - Alternative transport implementation in pi-web-ui package
  - Uses `genai.mariozechner.at` backend with OAuth tokens
  - **Not used by Sitegeist** - Sitegeist only uses `ProviderTransport`

### Default Configuration

**Location**: `src/sidepanel.ts:776-785`

```typescript
const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
if (proxyEnabled === null) {
  await storage.settings.set("proxy.enabled", true);
  await storage.settings.set("proxy.url", "https://proxy.mariozechner.at/proxy");
}
```

**Defaults**: in this fork the proxy is **off**. `src/sidepanel.ts` sets `proxy.enabled` to
`false` each time the side panel starts, because the `declarativeNetRequest` rules in
`static/cors-rules.json` add the CORS headers the providers need. The first-run block above
is upstream's; a proxy turned on in Settings lasts until the panel next starts.

### Storage Schema

Settings stored in IndexedDB under `sitegeist-storage` database:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `proxy.enabled` | `boolean` | `true` | Whether CORS proxy is enabled |
| `proxy.url` | `string` | `"https://proxy.mariozechner.at/proxy"` | CORS proxy server URL |

## Provider-Specific Proxy Logic

The proxy system uses hardcoded provider rules to determine when proxy is necessary:

### Providers That Require Proxy

1. **Z-AI** - Always uses proxy (CORS blocked)
2. **Anthropic with OAuth tokens** - API keys starting with `sk-ant-oat-` use proxy
   - Regular Anthropic API keys (`sk-ant-api-*`) do NOT use proxy

### Providers That Work Without Proxy

These providers have proper CORS headers and connect directly:
- OpenAI
- Google Gemini
- Groq
- OpenRouter
- Cerebras
- xAI (Grok)
- Ollama
- LM Studio

### Unknown Providers

For providers not in the hardcoded list, the system defaults to NOT using proxy. This allows new providers to work by default without proxy configuration.

## Document Extraction Proxy Behavior

The `extract_document` tool implements a try-first-fallback strategy:

1. **First attempt**: Direct fetch to the document URL
2. **On CORS error**: If proxy is configured, retry the fetch through proxy
3. **On success**: Return extracted document text
4. **On failure**:
   - If proxy available but also failed: Show error about both attempts
   - If no proxy configured: Show error suggesting proxy setup or manual download
   - If non-CORS error: Re-throw immediately without proxy retry

This approach minimizes proxy usage since many document URLs don't have CORS restrictions.

## Technical Details

### Proxy URL Format

The CORS proxy expects URLs in this format:
```
https://proxy.mariozechner.at/proxy/?url=<encoded-target-url>
```

Example:
```typescript
const targetUrl = "https://api.anthropic.com/v1/messages";
const proxyUrl = "https://proxy.mariozechner.at/proxy";
const proxiedUrl = `${proxyUrl}/?url=${encodeURIComponent(targetUrl)}`;
// Result: "https://proxy.mariozechner.at/proxy/?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages"
```

### How the Proxy Works

1. Browser makes request to proxy server
2. Proxy server receives request with target URL
3. Proxy makes request to target URL from server (no CORS issues)
4. Proxy strips CORS headers from response
5. Proxy returns response to browser

This bypasses browser CORS restrictions because:
- The actual cross-origin request is made by the server (not subject to CORS)
- The browser only communicates with the proxy (same-origin or CORS-enabled)

### Privacy Considerations

From tutorials.ts:90:
> CORS proxy (on by default): If enabled in settings, requests to the LLM go through the proxy due to CORS restrictions when using an Anthropic OAuth token, or using Z-AI. Default is https://proxy.mariozechner.at/proxy which does not retain or log data. Use your own proxy or a service like corsproxy.io if preferred

Users can:
1. Disable the proxy (if using providers that don't need it)
2. Use their own self-hosted proxy
3. Use alternative services (e.g., corsproxy.io)

## Benefits of Current Implementation

### Minimal Proxy Usage
- Only Z-AI and Anthropic OAuth tokens use proxy for LLM requests
- Document extraction tries direct fetch first
- Most requests (OpenAI, Google, etc.) connect directly

### Better Performance
- Direct connections are faster (no proxy hop)
- Reduced load on proxy infrastructure
- Less bandwidth through proxy

### Clearer Error Messages
- CORS errors detected and handled specifically
- Users get helpful messages about proxy configuration
- Distinguishes CORS issues from other network errors

### User Control
- Proxy can be disabled completely if not needed
- Custom proxy URLs supported
- Settings clearly explain when proxy is required

## Related Files

### Sitegeist Extension
- `src/sidepanel.ts` - Proxy initialization and tool configuration
- `src/tutorials.ts` - User-facing proxy explanation
- `docs/settings.md` - Proxy settings documentation

### pi-web-ui Package
- `src/utils/proxy-utils.ts` - Centralized proxy decision logic
- `src/agent/transports/ProviderTransport.ts` - LLM request proxy logic (USED by Sitegeist)
- `src/agent/transports/AppTransport.ts` - Alternative transport (NOT used by Sitegeist)
- `src/agent/transports/proxy-types.ts` - Event types for AppTransport (NOT used by Sitegeist)
- `src/tools/extract-document.ts` - Document extraction with try-first-fallback proxy
- `src/components/ProviderKeyInput.ts` - API key testing with selective proxy
- `src/dialogs/SettingsDialog.ts` - Proxy settings UI
- `src/storage/stores/settings-store.ts` - Settings persistence

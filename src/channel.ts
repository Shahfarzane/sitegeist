/**
 * The build channel this code runs in (src/channels.json): "production" is the Chrome Web Store
 * item and its CLI, "dev" a copy built from a checkout and loaded unpacked beside it, with its own
 * id, native host, CLI build and socket folder, so agents on one never see the other.
 *
 * scripts/build.mjs and cli/scripts/build.mjs replace process.env.SITEGEIST_CHANNEL with the
 * channel they build, so a built extension or CLI never takes it from the environment, and their
 * builds give it a channels.json with that channel alone (onlyThisChannel). Unbundled tests set the
 * variable before they import this.
 */

import channels from "./channels.json" with { type: "json" };

export type ChannelName = keyof typeof channels;

export const CHANNEL_NAME: ChannelName = process.env.SITEGEIST_CHANNEL === "dev" ? "dev" : "production";

export const CHANNEL = channels[CHANNEL_NAME];

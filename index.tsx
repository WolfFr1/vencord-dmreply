import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, GuildMemberStore, UserStore, ChannelActionCreators, RelationshipStore, MessageStore } from "@webpack/common";
import { Logger } from "@utils/Logger";
import { sendMessage as sendDiscordMessage } from "@utils/discord";
import { get as getStore, set as setStore } from "@api/DataStore";

const logger = new Logger("DMRedirect");

// Persisted key for users we've replied to
const PERSIST_KEY = "DMRedirect_RepliedUsers";

// Reply once per user (disabled in test mode)
let repliedUsers = new Set<string>();

// Helper: check if this DM has prior history (messages other than the current one)
async function dmHasHistory(channelId: string, currentMessageId: string): Promise<boolean> {
    try {
        if (MessageStore.hasPresent?.(channelId)) {
            const data: any = MessageStore.getMessages(channelId);
            const arr = data?._array ?? (Array.isArray(data) ? data : undefined);

            if (Array.isArray(arr)) {
                return arr.some((m: any) => m?.id && m.id !== currentMessageId);
            }

            if (typeof data?.size === "number") return data.size > 1;
            if (typeof data?.forEach === "function") {
                let count = 0;
                data.forEach((m: any) => { if (m?.id !== currentMessageId) count++; });
                return count > 0;
            }

            return false;
        }

        // Wait briefly for the store to populate, then check again
        await new Promise<void>(resolve => {
            let done = false;
            const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, 400);
            try {
                MessageStore.whenReady?.(channelId, () => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
            } catch {
                resolve();
            }
        });

        if (MessageStore.hasPresent?.(channelId)) {
            const data: any = MessageStore.getMessages(channelId);
            const arr = data?._array ?? (Array.isArray(data) ? data : undefined);

            if (Array.isArray(arr)) return arr.some((m: any) => m?.id && m.id !== currentMessageId);
            if (typeof data?.size === "number") return data.size > 1;
            if (typeof data?.forEach === "function") {
                let count = 0;
                data.forEach((m: any) => { if (m?.id !== currentMessageId) count++; });
                return count > 0;
            }
        }
    } catch {
        // ignore
    }
    return false;
}

// Plugin settings (user can edit in Vencord UI)
const settings = definePluginSettings({
    guildId: {
        type: OptionType.STRING,
        description: "Target server ID where users should open a ticket",
        default: "1283383478913732628"
    },
    reply1: {
        type: OptionType.STRING,
        description: "First auto-reply message",
        default: "Hey 👋 I don’t respond to DMs. Please open a ticket in our support server instead."
    },
    reply2: {
        type: OptionType.STRING,
        description: "Second auto-reply message (e.g. an emoji)",
        default: ""
    },
    reply3: {
        type: OptionType.STRING,
        description: "Third auto-reply message",
        default: ""
    },
    testMode: {
        type: OptionType.BOOLEAN,
        description: "Reply to every DM (ignore server membership and one-time limit)",
        default: true
    }
});

export default definePlugin({
    name: "DMRedirect",
    description: "Auto-reply to new DMs telling people to use tickets in your server.",
    authors: [{ name: "Wolf", id: 0n }],
    settings,

    async start() {
        try {
            const saved = await getStore(PERSIST_KEY) as Set<string> | string[] | undefined;
            if (saved) repliedUsers = new Set(Array.isArray(saved) ? saved : Array.from(saved));
        } catch (e) {
            logger.warn("Failed to load replied users list", e);
        }
    },

    stop() {
        repliedUsers.clear();
    },

    flux: {
        async MESSAGE_CREATE(event: any) {
            try {
                const { message: msg, optimistic } = event;
                if (!msg) return;
                if (optimistic) return;

                const channel = ChannelStore.getChannel(msg.channel_id);
                if (!channel) return;

                // Only DM channels
                if (channel.type !== 1) return;

                // Ignore our own messages and bots
                const me = UserStore.getCurrentUser();
                if (msg.author?.id === me?.id) return;
                if (msg.author?.bot) return;
                // Ignore friends
                if (RelationshipStore.isFriend(msg.author.id)) return;

                // In normal mode, only reply once per user and only if they're in the target guild
                if (!settings.store.testMode) {
                    if (repliedUsers.has(msg.author.id)) return;
                    if (!GuildMemberStore.isMember(settings.store.guildId, msg.author.id)) return;

                    // Skip if there is existing DM history
                    if (await dmHasHistory(channel.id, msg.id)) return;
                }

                // Build up to 3 messages, skipping empty ones
                const m1 = (settings.store.reply1 ?? "").trim();
                const m2 = (settings.store.reply2 ?? "").trim();
                const m3 = (settings.store.reply3 ?? "").trim();
                const toSend = [m1, m2, m3].filter(Boolean) as string[];
                if (toSend.length === 0) return;

                for (const content of toSend) {
                    await sendDiscordMessage(
                        channel.id,
                        { content },
                        true,
                        { allowedMentions: { parse: [], replied_user: false } }
                    ).catch(err => {
                        logger.error("Failed to send auto-reply", err);
                    });
                }

                // Small delay to ensure messages flush before closing
                await new Promise(r => setTimeout(r, 250));
                ChannelActionCreators.closePrivateChannel(channel.id);

                // Remember we replied once (normal mode only) and persist
                if (!settings.store.testMode) {
                    repliedUsers.add(msg.author.id);
                    setStore(PERSIST_KEY, repliedUsers).catch(e => logger.warn("Failed to persist replied users", e));
                }
            } catch (e) {
                logger.error("MESSAGE_CREATE handler error", e);
            }
        }
    }
});

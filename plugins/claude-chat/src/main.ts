/// The Claude chat, as a TermIAu plugin: a panel's Claude conversation in bubbles,
/// read from the transcript and drawn over the terminal — the plugin's layer on the
/// panel (`Panel.layer`). The terminal stays alive below, with the session running:
/// the chat is another way of seeing the same conversation, and what you write in its
/// field goes to Claude the same way as the keyboard.
///
/// It follows the session through the Claude Code plugin (`ClaudeApi`), which also
/// reads the transcript and the `/commands` on disk with its engine.
import type { Panel, PluginContext } from "../../../src/plugins/api";
import { loadSettings, onSettings, saveViewMode } from "../../../src/differ/lib/persist";
import type { ViewMode } from "../../../src/differ/types";
import { markdown } from "../../../src/markdown";
import { CLAUDE_PLUGIN, type ClaudeApi, type ClaudePanel, type QuestionItem, type SavedSession } from "../../claude/src/api";
import {
  claudeCommands,
  choiceText,
  diffLines,
  filterCommands,
  hookAnswer,
  partsOfYour,
  provisionalResolved,
  readMessages,
  sideBySide,
  type Choice,
  type Command,
  type FileDiff,
  type LineDiff,
  type Message,
} from "./conversation";
import { texts } from "./i18n";

/// A panel's chat.
type Chat = {
  panel: Panel;
  /// The plugin's layer on the panel: what fades in and out over the terminal.
  layer: HTMLElement;
  el: HTMLDivElement;
  list: HTMLDivElement;
  notice: HTMLDivElement;
  noticeText: HTMLSpanElement;
  /// The Claude question card, and which question is the one drawn:
  /// redrawing on every change would erase what you already checked.
  question: HTMLDivElement;
  questionOf?: string;
  /// The "working…" line between the conversation and the field, and since when.
  thinking: HTMLDivElement;
  thinkingSince?: number;
  /// Your bubbles already on screen but not yet in the transcript: Claude
  /// only stores the prompt when it receives it, and waiting for it made sending
  /// look stuck. They go away, in order, when the real ones arrive.
  pending: { el: HTMLElement; text: string }[];
  /// The buttons that answer a permission request without leaving the chat.
  allow: HTMLButtonElement;
  deny: HTMLButtonElement;
  campo: HTMLTextAreaElement;
  /// The `/commands` list, above the field while typing one.
  menu: HTMLDivElement;
  /// The commands from disk (yours, the project's, the plugins') and the ones matching
  /// what is typed, with the selected one.
  commands: Command[];
  findings: Command[];
  picked: number;
  /// The sessions to resume, while the `/resume` list is open: then the
  /// menu shows these, and what is typed in the field filters them.
  sessions?: SavedSession[];
  sessionsFound: SavedSession[];
  /// "Show earlier": the turns left off screen (see `CHAT_WINDOW`).
  more: HTMLButtonElement;
  /// The whole conversation, and from which turn it is drawn.
  messages: Message[];
  since: number;
  /// Where the scroll was, to restore it when the browser resets it.
  top: number;
  atEnd: boolean;
  /// Present while the list is being taken to the end (see `restoreScroll`).
  stick?: number;
  /// A notice from the chat itself, in the same strip as "Claude is waiting for you".
  flash?: string;
  isOpen: boolean;
  /// The transcript on screen, and up to which byte of it has been read.
  path?: string;
  end: number;
  reading?: boolean;
  pulse?: ReturnType<typeof setInterval>;
  /// The thumbnails of the images already pasted into Claude's prompt, waiting for Enter.
  attachments: HTMLDivElement;
  /// The fade in or out in progress: toggling midway starts from where it stopped.
  transition?: Animation;
  resize: ResizeObserver;
};

/// How often the open chat checks whether the transcript grew. Claude
/// only writes a turn when it ends, so there is nothing to gain by reading
/// faster — and when closed, the chat reads nothing.
const CHAT_MS = 700;
/// How many turns go on screen at a time. A long session has thousands, and
/// drawing them all makes a huge document the browser redoes entirely on
/// every change of panel width — splitting, maximizing and switching modes
/// got heavy in proportion to the conversation.
const CHAT_WINDOW = 80;
/// Shorter than maximize's: it is a layer appearing, not the layout moving.
const CHAT_DURATION = 180;
/// How many diff lines go on screen. A `Write` of a whole file
/// would have thousands; the rest is in the file.
const DIFF_MAX = 400;
/// From how many lines (or characters, for whoever pastes one huge
/// line) a text starts collapsed. A pasted log took the whole screen and
/// pushed the answer far away.
const LONG_LINES = 10;
const LONG_CHARS = 900;

const stroke = (d: string) =>
  `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON_CHAT = stroke("M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z");
const ICON_COPY = stroke("M5.5 5.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM2.5 10.5V3a1 1 0 0 1 1-1h7.5");
const ICON_COPIED = stroke("M3 8.5l3.2 3L13 4.5");
const ICON_UNIFIED = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M4.5 6h7M4.5 10h7"/></svg>`;
const ICON_SIDE_SIDE = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M8 2.5v11"/></svg>`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

let dispose: (() => void) | undefined;

export function activate(ctx: PluginContext) {
  dispose = createChats(ctx);
}

export function deactivate() {
  dispose?.();
  dispose = undefined;
}

function createChats(ctx: PluginContext): () => void {
  const t = texts(ctx.language);
  const claude = ctx.plugins.api<ClaudeApi>(CLAUDE_PLUGIN);
  const CLAUDE_COMMANDS = claudeCommands(t);
  const chats = new Map<number, Chat>();
  const buttons = new Map<number, HTMLButtonElement>();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  // ---------- the bar button ----------

  /// Always at hand: with a Claude session it switches modes; without one, it opens one
  /// in this folder, already in chat.
  function drawButton(id: number) {
    const b = buttons.get(id);
    if (!b) return;
    const inChat = chats.get(id)?.isOpen === true;
    b.classList.toggle("on", inChat);
    b.title = inChat ? t.backToTerminalChat : claude.panel(id) ? t.viewInChatMode : t.openClaudeInChat;
  }

  // ---------- the strip, the card, the "working…" line ----------

  /// The strip above the field: Claude stopped to wait for you, or the chat has
  /// something to say. With neither, it doesn't exist.
  function drawNotice(chat: Chat) {
    const c = claude.panel(chat.panel.id);
    const question = c?.question;
    chat.question.hidden = !question;
    if (!question) chat.questionOf = undefined;
    else if (chat.questionOf !== question.id) drawQuestion(chat, question);
    // With the card on screen, the strip would only say the same as it.
    const waiting = c?.state === "waiting" && !question;
    chat.notice.hidden = !waiting && !chat.flash;
    chat.noticeText.textContent = waiting ? (c?.notice ?? t.isWaiting) : (chat.flash ?? "");
    chat.noticeText.title = chat.noticeText.textContent;
    const permission = waiting && c?.asks === "permission";
    chat.allow.hidden = chat.deny.hidden = !permission;
    drawThinking(chat);
  }

  /// "Working… 12s": Claude received it and hasn't finished the turn yet. It is what
  /// the terminal shows with the spinning asterisk; without this, the chat stood still
  /// and there was no way to know whether the message had arrived.
  function drawThinking(chat: Chat) {
    const working = claude.panel(chat.panel.id)?.state === "working";
    chat.thinking.hidden = !working;
    if (!working) {
      chat.thinkingSince = undefined;
      return;
    }
    chat.thinkingSince ??= Date.now();
    const s = Math.floor((Date.now() - chat.thinkingSince) / 1000);
    const time = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    chat.thinking.textContent = t.working(time);
  }

  /// The card for a Claude question, in steps: one question at a time, with
  /// tabs for all of them on top to go back and forth. In a single-choice question, the
  /// click already answers and moves to the next — and, on the last, sends everything —, like
  /// in the terminal. Multiple choice, "Other…" and options with a preview need the button.
  function drawQuestion(chat: Chat, question: { id: string; questions: QuestionItem[] }) {
    chat.questionOf = question.id;
    const { questions } = question;
    const choices: Choice[] = questions.map(() => ({ labels: [] }));
    let step = 0;
    const answered = (i: number) => choiceText(choices[i]) !== undefined;

    const send = () => {
      const answer = hookAnswer(questions, choices);
      if (!answer || claude.panel(chat.panel.id)?.question?.id !== question.id) return;
      claude.answerQuestion(chat.panel.id, answer).catch((e) => {
        // The terminal answered first, or Claude gave up on the question.
        chat.flash = t.alreadyAnsweredInTerminal;
        ctx.log(`answerQuestion: ${e}`);
        drawNotice(chat);
      });
      chat.panel.focus();
    };
    /// Goes to the next unanswered one; with none missing, sends.
    const advance = () => {
      const missing = questions.findIndex((_, i) => i > step && !answered(i));
      const before = questions.findIndex((_, i) => !answered(i));
      const next = missing >= 0 ? missing : before;
      if (next < 0) return send();
      step = next;
      draw();
    };

    const draw = () => {
      const q = questions[step];
      const e = choices[step];
      const elements: HTMLElement[] = [];

      // The tabs: with a single question there is nowhere to go.
      if (questions.length > 1) {
        const tabs = element("div", "chat-question-tabs");
        for (const [i, other] of questions.entries()) {
          const tab = element("button", "chat-question-tab");
          tab.textContent = `${answered(i) ? "✓" : "○"} ${other.header || t.questionN(i + 1)}`;
          tab.setAttribute("aria-current", String(i === step));
          tab.addEventListener("click", () => {
            step = i;
            draw();
          });
          tabs.append(tab);
        }
        elements.push(tabs);
      } else if (q.header) {
        const tag = element("span", "chat-question-label");
        tag.textContent = q.header;
        elements.push(tag);
      }

      const text = element("div", "chat-question-text");
      text.textContent = q.question;
      if (q.multiSelect) {
        const hint = element("span", "chat-question-hint");
        hint.textContent = t.pickAnyNumber;
        text.append(hint);
      }
      const hasPreview = q.options.some((o) => o.preview);
      const direct = !q.multiSelect && !hasPreview;
      const options = element("div", "chat-question-options");
      const preview = element("pre", "chat-question-preview");
      const chosen = q.options.find((o) => e.labels.includes(o.label) && o.preview);
      preview.hidden = !chosen;
      preview.textContent = chosen?.preview ?? "";
      const other = element("input", "chat-question-other");
      other.placeholder = t.writeYourAnswer;
      other.value = e.other ?? "";
      other.hidden = e.other === undefined;

      for (const o of q.options) {
        const b = element("button", "chat-option");
        b.setAttribute("aria-pressed", String(e.labels.includes(o.label)));
        const label = element("span", "chat-option-label");
        label.textContent = o.label;
        b.append(label);
        if (o.description) {
          const d = element("span", "chat-option-description");
          d.textContent = o.description;
          b.append(d);
        }
        b.addEventListener("click", () => {
          if (q.multiSelect) {
            e.labels = e.labels.includes(o.label) ? e.labels.filter((l) => l !== o.label) : [...e.labels, o.label];
          } else {
            e.labels = [o.label];
            e.other = undefined;
          }
          if (direct) return advance();
          draw();
        });
        options.append(b);
      }
      const otherButton = element("button", "chat-option");
      otherButton.textContent = t.other;
      otherButton.setAttribute("aria-pressed", String(e.other !== undefined));
      otherButton.addEventListener("click", () => {
        // In a single choice, writing your own unchecks the checked one.
        if (!q.multiSelect) e.labels = [];
        e.other ??= "";
        draw();
        chat.question.querySelector<HTMLInputElement>(".chat-question-other")?.focus();
      });
      options.append(otherButton);
      other.addEventListener("input", () => {
        e.other = other.value;
        follow.disabled = !answered(step);
      });
      other.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" || ev.isComposing) return;
        ev.preventDefault();
        if (answered(step)) advance();
      });

      const actions = element("div", "chat-question-actions");
      const terminal = element("button", "chat-question-terminal");
      terminal.textContent = t.viewInTerminal;
      terminal.addEventListener("click", () => toggle(chat.panel));
      const goBack = element("button", "chat-question-terminal");
      goBack.textContent = t.goBack;
      goBack.addEventListener("click", () => {
        step--;
        draw();
      });
      // On the last unanswered one the button already sends; before it, it moves on.
      const last = questions.every((_, i) => i === step || answered(i));
      const follow = element("button", "chat-question-answer");
      follow.textContent = last ? t.reply : t.next;
      follow.disabled = !answered(step);
      follow.addEventListener("click", advance);
      actions.append(terminal);
      if (step > 0) actions.append(goBack);
      actions.append(follow);

      elements.push(text, options, other, preview, actions);
      chat.question.replaceChildren(...elements);
    };
    draw();
  }

  // ---------- the scroll ----------

  /// Puts the chat's scroll back where you left it.
  function restoreScroll(chat: Chat) {
    const { list } = chat;
    if (!chat.atEnd) {
      if (list.scrollTop !== chat.top) list.scrollTop = chat.top;
      return;
    }
    list.scrollTop = list.scrollHeight;
    // Once isn't enough to reach the end: off-screen turns have a guessed height
    // (`content-visibility`), and only get the real one when the scroll reaches them —
    // then the list grows and the end is somewhere else. It insists for a few frames,
    // until the height stops changing.
    if (chat.stick !== undefined) return;
    let frames = 0;
    let equal = 0;
    let before = -1;
    const step = () => {
      chat.stick = undefined;
      if (!chat.isOpen || !chat.atEnd) return;
      const height = list.scrollHeight;
      list.scrollTop = height;
      equal = height === before ? equal + 1 : 0;
      before = height;
      if (++frames < 30 && equal < 2) chat.stick = requestAnimationFrame(step);
    };
    chat.stick = requestAnimationFrame(step);
  }

  /// Draws one more batch of older turns, above the ones already on screen,
  /// without moving what you are reading.
  function showPrevious(chat: Chat) {
    const to = chat.since;
    chat.since = Math.max(0, to - CHAT_WINDOW);
    const height = chat.list.scrollHeight;
    chat.more.after(...chat.messages.slice(chat.since, to).map(drawMessage));
    chat.more.hidden = chat.since === 0;
    chat.list.scrollTop += chat.list.scrollHeight - height;
  }

  /// Jumps between your bubbles (⌘⇧↑/↓ with the chat on screen).
  function goToMessage(chat: Chat, delta: number) {
    const top = chat.list.scrollTop;
    const yours = [...chat.list.querySelectorAll<HTMLElement>(".chat-you")].map((el) => el.offsetTop - 12);
    const target = delta < 0 ? yours.filter((y) => y < top - 1).pop() : yours.find((y) => y > top + 1);
    chat.list.scrollTo({ top: target ?? (delta < 0 ? 0 : chat.list.scrollHeight) });
  }

  /// The thumbnails go away along with the message that took them.
  function clearAttachments(chat: Chat) {
    for (const img of chat.attachments.querySelectorAll("img")) URL.revokeObjectURL(img.src);
    chat.attachments.replaceChildren();
    chat.attachments.hidden = true;
  }

  // ---------- the chat ----------

  function createChat(panel: Panel): Chat {
    const id = panel.id;
    const layer = panel.layer();
    const el = element("div", "chat");
    const list = element("div", "chat-list");
    list.dataset.empty = t.chatEmpty;
    const question = element("div", "chat-question");
    question.hidden = true;
    const thinking = element("div", "chat-thinking");
    thinking.hidden = true;
    const notice = element("div", "chat-notice");
    const noticeText = element("span", "chat-notice-text");
    const allow = element("button", "chat-notice-yes");
    allow.textContent = t.allow;
    allow.addEventListener("click", () => {
      claude.answerPermission(id, true);
      panel.focus();
    });
    const deny = element("button", "chat-notice-not");
    deny.textContent = t.deny;
    deny.addEventListener("click", () => {
      claude.answerPermission(id, false);
      panel.focus();
    });
    const view = element("button", "chat-notice-view");
    view.textContent = t.viewInTerminal;
    view.addEventListener("click", () => toggle(panel));
    notice.append(noticeText, allow, deny, view);
    const more = element("button", "chat-more");
    more.textContent = t.showPrevious;
    more.hidden = true;
    const campo = element("textarea", "chat-field");
    campo.rows = 1;
    campo.spellcheck = false;
    campo.setAttribute("autocorrect", "off");
    campo.placeholder = t.messageForClaude;
    const menu = element("div", "chat-commands");
    menu.hidden = true;
    const attachments = element("div", "chat-attachments");
    attachments.hidden = true;
    el.append(list, thinking, question, notice, menu, attachments, campo);
    layer.append(el);

    const grow = () => {
      campo.style.height = "auto";
      campo.style.height = `${Math.min(campo.scrollHeight, 160)}px`;
    };
    /// Sends the text to Claude. A `/command` goes typed, not pasted: typed
    /// is how Claude Code recognizes it as a command in every case. The
    /// rest goes the paste way, like ⌘V — several lines arrive as
    /// a single block, not as an Enter at each break. Enter goes after, on
    /// its own: together with the paste Claude would take it as one more line of it.
    const send = (text: string) => {
      // `/resume` alone would open the session list in the terminal, where the chat
      // can't see it. The list is built here, and what goes to Claude is
      // `/resume` already with the chosen session.
      if (text === "/resume") return void openSessions(chat);
      chat.sessions = undefined;
      clearAttachments(chat);
      campo.value = "";
      grow();
      drawCommands(chat);
      const command = /^\/([\w:.-]+)/.exec(text);
      // The message goes on screen right away, dimmed until the transcript confirms it. A
      // `/command` doesn't: many don't even become turns, and the bubble would hang there.
      if (!command) {
        const balao = drawMessage({ who: "you", text });
        balao.classList.add("pending");
        chat.list.append(balao);
        chat.pending.push({ el: balao, text });
        chat.atEnd = true;
        restoreScroll(chat);
        claude.setState(id, "working");
      }
      if (command && !text.includes("\n")) panel.write(text);
      else panel.paste(text);
      setTimeout(() => panel.write("\r"), 80);
      // What the command opens (the model list, the sessions to resume) shows
      // in the terminal, and that is where it is answered. The chat doesn't step aside on its own:
      // it notifies, and the notice's button takes you there.
      const name = command?.[1];
      // With an argument the command already says what it wants, and opens no screen.
      const opensScreen = text === `/${name}` && CLAUDE_COMMANDS.some((c) => c.interactive && c.name === name);
      chat.flash = opensScreen ? t.openedScreenInTerminal(name ?? "") : undefined;
      drawNotice(chat);
    };
    const completeWith = (c: Command) => {
      campo.value = `/${c.name} `;
      grow();
      drawCommands(chat);
    };

    campo.addEventListener("input", () => {
      grow();
      // Writing the answer is attending, like the first key in the terminal.
      claude.attend(id);
      // Just opened the list: the commands on disk may have changed since the
      // last time (a new skill, another project).
      if (campo.value === "/") void loadCommands(chat);
      chat.picked = 0;
      drawCommands(chat);
    });
    const resumeSession = (s: SavedSession) => send(`/resume ${s.id}`);
    const closeSessions = () => {
      chat.sessions = undefined;
      campo.value = "";
      grow();
      drawCommands(chat);
    };
    menu.addEventListener("mousedown", (e) => {
      // The click doesn't take the keyboard away from the field.
      e.preventDefault();
      const item = (e.target as HTMLElement).closest<HTMLElement>(".chat-command");
      if (!item) return;
      if (chat.sessions) {
        const s = chat.sessionsFound[Number(item.dataset.i)];
        if (s) resumeSession(s);
        return;
      }
      const c = chat.findings[Number(item.dataset.i)];
      if (c) completeWith(c);
    });
    campo.addEventListener("keydown", (e) => {
      if (ctx.ui.isShortcut(e)) return;
      if (chat.sessions) {
        const n = chat.sessionsFound.length;
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
          e.preventDefault();
          chat.picked = (chat.picked + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
          return drawCommands(chat);
        }
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          const s = chat.sessionsFound[chat.picked];
          if (s) resumeSession(s);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          return closeSessions();
        }
        return;
      }
      if (!menu.hidden && chat.findings.length) {
        const n = chat.findings.length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          chat.picked = (chat.picked + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
          return drawCommands(chat);
        }
        // Tab completes, for those who will write the arguments; Enter sends right away.
        if (e.key === "Tab") {
          e.preventDefault();
          return completeWith(chat.findings[chat.picked]);
        }
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          return send(`/${chat.findings[chat.picked].name}`);
        }
        // Esc closes the list; only without it does it interrupt Claude.
        if (e.key === "Escape") {
          e.preventDefault();
          menu.hidden = true;
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        const c = claude.panel(id);
        // With a permission request open, esc there is the "no": the notice goes along.
        if (c?.state === "waiting" && c.asks === "permission") return claude.answerPermission(id, false);
        panel.write("\x1b");
        // When interrupted, Claude doesn't send `Stop`: "working" goes away here.
        if (c?.state === "working") claude.setState(id, "idle");
        return;
      }
      // Enter in the middle of a composition (accent, IME) confirms the letter, doesn't send.
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      // The marker in the field is only for you to see where the image is: in Claude's
      // prompt it already went in with ⌃V, and sent again it would become text.
      const text = campo.value.replace(/\[Image #\d+\] ?/g, "").trim();
      if (text) send(text);
      else if (!chat.attachments.hidden) {
        campo.value = "";
        grow();
        panel.write("\r");
        clearAttachments(chat);
      }
    });
    // Clicking anywhere in the chat is like clicking in the terminal: the keyboard goes
    // to the field, and you can just start typing. Except when the click was for
    // something else — a button, a link, another field — or to select text.
    el.addEventListener("mouseup", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input, textarea, select, summary")) return;
      if (!(getSelection()?.isCollapsed ?? true)) return;
      campo.focus({ preventScroll: true });
    });
    // A link in the answer opens outside, like the terminal's: inside, it would replace the
    // whole app's page with the link's.
    list.addEventListener("click", (e) => {
      // ⌘-click on a `path:line` in the answer opens the file in the viewer.
      if (ctx.ui.openReference(panel, e)) return;
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      e.preventDefault();
      ctx.ui.openLink(e, a.href);
    });
    // A pasted image goes to Claude as in the terminal: ⌃V is what makes Claude
    // Code read the clipboard and attach it to the prompt it is building. The
    // field's text goes after, along with Enter.
    campo.addEventListener("paste", (e) => {
      const file = [...(e.clipboardData?.items ?? [])]
        .find((i) => i.kind === "file" && i.type.startsWith("image/"))
        ?.getAsFile();
      if (!file) return;
      e.preventDefault();
      panel.write("\x16");
      const img = element("img", "chat-attachment");
      img.src = URL.createObjectURL(file);
      img.alt = t.attachedImage;
      img.addEventListener("click", () => expandImage(img.src));
      attachments.append(img);
      attachments.hidden = false;
      // The number Claude Code will give it: it counts across the whole session.
      const seenOnes = chat.messages.flatMap((f) =>
        f.who === "you" ? [...f.text.matchAll(/\[Image #(\d+)\]/g)].map((m) => Number(m[1])) : [],
      );
      const n = Math.max(0, ...seenOnes) + attachments.childElementCount;
      const from = campo.selectionStart ?? campo.value.length;
      campo.setRangeText(`[Image #${n}] `, from, campo.selectionEnd ?? from, "end");
      grow();
    });

    // Splitting, closing and switching tabs move the panel out of place (or off screen), and
    // the browser resets the scroll of whatever goes through that.
    const resize = new ResizeObserver(() => {
      if (chat.isOpen) restoreScroll(chat);
    });
    resize.observe(el);

    const chat: Chat = {
      panel,
      layer,
      el,
      list,
      notice,
      noticeText,
      question,
      thinking,
      pending: [],
      allow,
      deny,
      campo,
      menu,
      commands: [],
      findings: [],
      picked: 0,
      attachments,
      sessionsFound: [],
      more,
      messages: [],
      since: 0,
      top: 0,
      atEnd: true,
      isOpen: false,
      end: 0,
      resize,
    };
    more.addEventListener("click", () => showPrevious(chat));
    list.addEventListener(
      "scroll",
      () => {
        // Off screen the list has no height, and what it says about the scroll is zero.
        // And on the way to the end, the positions passed through aren't your choice.
        if (!list.clientHeight || chat.stick !== undefined) return;
        chat.top = list.scrollTop;
        chat.atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      },
      { passive: true },
    );
    // Scrolled by hand midway: you are in charge.
    list.addEventListener(
      "wheel",
      () => {
        if (chat.stick === undefined) return;
        cancelAnimationFrame(chat.stick);
        chat.stick = undefined;
      },
      { passive: true },
    );
    return chat;
  }

  /// The commands and skills on disk, for the `/` list. The folder is the
  /// session's: it is from there that Claude Code sees the project's `.claude`.
  async function loadCommands(chat: Chat) {
    try {
      chat.commands = await claude.commands(claude.panel(chat.panel.id)?.folder);
      drawCommands(chat);
    } catch (e) {
      ctx.log(`commands: ${e}`);
    }
  }

  /// The list shows while the field is just a slash and a name with no space yet;
  /// after the space come the arguments, and it gets out of the way.
  function drawCommands(chat: Chat) {
    if (chat.sessions) return drawSessions(chat);
    const typed = /^\/([\w:.-]*)$/.exec(chat.campo.value);
    chat.findings = typed ? filterCommands([...chat.commands, ...CLAUDE_COMMANDS], typed[1]) : [];
    chat.menu.hidden = !chat.findings.length;
    if (chat.menu.hidden) return;
    chat.picked = Math.min(chat.picked, chat.findings.length - 1);
    chat.menu.replaceChildren(
      ...chat.findings.map((c, i) => {
        const item = element("div", "chat-command");
        item.dataset.i = String(i);
        item.classList.toggle("selected", i === chat.picked);
        const name = element("span", "chat-command-name");
        name.textContent = `/${c.name}`;
        const description = element("span", "chat-command-description");
        description.textContent = c.description;
        item.append(name, description);
        return item;
      }),
    );
    chat.menu.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }

  /// "5 min ago", "3 h ago", "2 d ago": enough to find yesterday's conversation.
  function howLongAgo(ms: number): string {
    const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
    if (min < 1) return t.now;
    if (min < 60) return t.haMin(min);
    if (min < 60 * 24) return t.hoursAgo(Math.round(min / 60));
    return t.daysAgo(Math.round(min / (60 * 24)));
  }

  /// The `/resume` list, inside the chat: the stored sessions of the folder this one
  /// was born in, which is where Claude Code looks for them.
  async function openSessions(chat: Chat) {
    chat.campo.value = "";
    chat.campo.style.height = "auto";
    const c = claude.panel(chat.panel.id);
    const folder = c?.folder ?? (await chat.panel.cwd());
    const every = folder ? await claude.sessions(folder).catch(() => []) : [];
    // The session we are already in isn't one to resume.
    const others = every.filter((s) => s.id !== c?.session);
    if (!others.length) {
      chat.flash = t.noOtherSession;
      return drawNotice(chat);
    }
    chat.flash = undefined;
    drawNotice(chat);
    chat.sessions = others;
    chat.picked = 0;
    drawCommands(chat);
    chat.campo.focus();
  }

  /// The menu, in place of the commands: the sessions whose title contains what is in the
  /// field. With the field empty, all of them.
  function drawSessions(chat: Chat) {
    const q = chat.campo.value.trim().toLowerCase();
    chat.sessionsFound = (chat.sessions ?? []).filter((s) => s.title.toLowerCase().includes(q));
    chat.picked = Math.max(0, Math.min(chat.picked, chat.sessionsFound.length - 1));
    const head = element("div", "chat-commands-head");
    head.textContent = chat.sessionsFound.length ? t.resumeSession : t.noSessionWithText;
    chat.menu.hidden = false;
    chat.menu.replaceChildren(
      head,
      ...chat.sessionsFound.map((s, i) => {
        const item = element("div", "chat-command chat-session");
        item.dataset.i = String(i);
        item.classList.toggle("selected", i === chat.picked);
        const title = element("span", "chat-session-title");
        title.textContent = s.title;
        const when = element("span", "chat-session-when");
        when.textContent = howLongAgo(s.modified);
        item.append(title, when);
        return item;
      }),
    );
    chat.menu.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }

  // ---------- the turns ----------

  function drawMessage(f: Message): HTMLElement {
    if (f.who === "tool") {
      const el = element("div", "chat-tool");
      const name = element("span", "chat-tool-name");
      name.textContent = f.name;
      const summary = element("span", "chat-tool-summary");
      summary.textContent = f.summary;
      el.append(name, summary);
      return el;
    }
    if (f.who === "diff") {
      const el = element("div", "chat-diffs");
      el.append(...f.files.map(drawDiff));
      return el;
    }
    // Your text goes as written; only Claude's answer is markdown.
    const el = element("div", f.who === "you" ? "chat-message chat-you" : "chat-message chat-claude markdown");
    if (f.who === "you") drawYour(el, f.text, f.images ?? []);
    else {
      el.innerHTML = markdown(f.text);
      copyButtons(el);
    }
    return el;
  }

  /// A copy button on each code block of a Claude answer. It copies the block as it is:
  /// the command ready to paste. In a frame around the block, not inside it: the block
  /// scrolls sideways, and the button would go along.
  function copyButtons(el: HTMLElement) {
    for (const pre of el.querySelectorAll<HTMLPreElement>("pre:not(.mermaid)")) {
      const outline = element("div", "code-block");
      const b = element("button", "copy-code");
      const goBack = () => {
        b.innerHTML = ICON_COPY;
        b.title = t.copyCode;
        b.classList.remove("copied");
      };
      goBack();
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard
          .writeText(pre.querySelector("code")?.textContent ?? pre.textContent ?? "")
          .then(() => {
            b.innerHTML = ICON_COPIED;
            b.title = t.codeCopied;
            b.classList.add("copied");
            setTimeout(goBack, 1500);
          })
          .catch((err) => ctx.log(`copy: ${err}`));
      });
      pre.replaceWith(outline);
      outline.append(pre, b);
    }
  }

  /// Unified or side by side: the same mode as the differ, stored in its
  /// preferences. Switching here switches there, and vice versa.
  let modeDiff: ViewMode = "unified";
  /// The file for each diff on screen, to redraw it when the mode changes.
  const diffFileOf = new WeakMap<HTMLElement, FileDiff>();

  /// Redraws the chats' diffs in the new mode. What was open stays open.
  function switchModeDiff(mode: ViewMode) {
    if (mode === modeDiff) return;
    modeDiff = mode;
    for (const chat of chats.values()) {
      for (const el of chat.el.querySelectorAll<HTMLElement>(".chat-diff")) {
        const file = diffFileOf.get(el);
        if (!file) continue;
        const isOpen = el.querySelector(".chat-collapsible-button") && !el.querySelector(".folded");
        const fresh = drawDiff(file);
        if (isOpen) fresh.querySelector<HTMLButtonElement>(".chat-collapsible-button")?.click();
        el.replaceWith(fresh);
      }
    }
  }

  /// What a tool changed in a file, as the terminal shows it: the name, the
  /// count, the numbered lines. As a preview like long messages — the
  /// first lines, and the rest one click away.
  function drawDiff(file: FileDiff): HTMLElement {
    const { lines, more, less } = diffLines(file);
    const el = element("div", "chat-diff");
    diffFileOf.set(el, file);
    const summary = element("div", "chat-diff-summary");
    const name = element("span", "chat-diff-file");
    name.textContent = file.path.split("/").pop() ?? file.path;
    name.title = file.path;
    const parts = [more && `+${more}`, less && `−${less}`].filter(Boolean).join(" ");
    const side = modeDiff === "split";
    // The icon is the one for the mode the click leads to.
    const mode = element("button", "chat-diff-mode");
    mode.innerHTML = side ? ICON_UNIFIED : ICON_SIDE_SIDE;
    mode.title = side ? t.viewUnified : t.viewSideBySide;
    mode.addEventListener("mousedown", (e) => e.preventDefault());
    mode.addEventListener("click", () => {
      const fresh: ViewMode = side ? "unified" : "split";
      switchModeDiff(fresh);
      saveViewMode(fresh).catch((e) => ctx.log(`save diff mode: ${e}`));
    });
    summary.append(name, ` ${parts}`, mode);
    // The numbers column is as wide as the largest of them.
    const width = String(Math.max(0, ...lines.map((l) => l.num ?? 0))).length;
    const cls = (l?: LineDiff) =>
      !l ? "empty" : l.kind === "+" ? "more" : l.kind === "-" ? "less" : l.kind === "…" ? "jump" : "";
    const pre = element("pre", side ? "chat-diff-lines side-by-side" : "chat-diff-lines");
    let total: number;
    if (side) {
      const pairs = sideBySide(lines);
      total = pairs.length;
      const half = (l?: LineDiff) => {
        const c = element("div", `chat-diff-line ${cls(l)}`);
        c.textContent = l ? `${String(l.num ?? "").padStart(width)} ${l.text}` : "";
        return c;
      };
      for (const p of pairs.slice(0, DIFF_MAX)) {
        if (p.jump) {
          const line = element("div", "chat-diff-line jump whole");
          line.textContent = "⋯";
          pre.append(line);
        } else pre.append(half(p.before), half(p.after));
      }
    } else {
      total = lines.length;
      for (const l of lines.slice(0, DIFF_MAX)) {
        const line = element("div", `chat-diff-line ${cls(l)}`);
        line.textContent = l.kind === "…" ? "⋯" : `${String(l.num ?? "").padStart(width)} ${l.kind} ${l.text}`;
        pre.append(line);
      }
    }
    const shown = Math.min(total, DIFF_MAX);
    el.append(summary, inPreview(pre, shown, shown > LONG_LINES));
    if (total > DIFF_MAX) {
      const note = element("div", "chat-diff-summary");
      note.textContent = t.moreLines(total - DIFF_MAX);
      el.append(note);
    }
    return el;
  }

  /// Your bubble: what you typed, what you pasted (without the `<pasted_content>` tags
  /// Claude Code puts around it) and the images, each where the text cites it.
  function drawYour(el: HTMLElement, text: string, images: string[]) {
    for (const p of partsOfYour(text, images.length)) {
      if (p.kind === "image") {
        const img = element("img", "chat-image");
        img.src = images[p.index];
        img.alt = t.imageN(p.index + 1);
        img.addEventListener("click", () => expandImage(img.src));
        el.append(img);
      } else if (p.kind === "pasted") {
        const box = element("div", "chat-pasted");
        const lines = p.text.split("\n").length;
        const title = element("div", "chat-pasted-title");
        title.textContent = t.pastedText(lines);
        box.append(title, collapsible(p.text));
        el.append(box);
      } else el.append(collapsible(p.text));
    }
  }

  /// A text that, when long, starts collapsed to a few lines with a button to
  /// open it. Short, it is just the text.
  function collapsible(text: string): HTMLElement {
    const body = element("div", "");
    body.textContent = text;
    const lines = text.split("\n").length;
    return inPreview(body, lines, lines > LONG_LINES || text.length > LONG_CHARS);
  }

  /// The same for any content (an edit's diff): `long` says whether it
  /// starts collapsed with the button, and `lines` is what the button counts.
  function inPreview(body: HTMLElement, lines: number, long: boolean): HTMLElement {
    const el = element("div", "chat-collapsible");
    body.classList.add("chat-collapsible-body");
    el.append(body);
    if (!long) return el;
    const button = element("button", "chat-collapsible-button");
    const label = () => {
      button.textContent = el.classList.contains("folded") ? t.showAll(lines) : t.collapse;
    };
    button.addEventListener("click", () => {
      el.classList.toggle("folded");
      label();
      // Collapsed from the middle (the button floats), the start of the text would be up
      // there, off screen: bring it back so you don't lose your place.
      if (el.classList.contains("folded")) el.scrollIntoView({ block: "nearest" });
    });
    el.classList.add("folded");
    el.append(button);
    label();
    return el;
  }

  /// The image at screen size, over everything. Click or esc closes it.
  function expandImage(src: string) {
    const background = element("div", "chat-image-enlarged");
    const img = element("img", "");
    img.src = src;
    background.append(img);
    const close = () => {
      background.remove();
      removeEventListener("keydown", esc, true);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    background.addEventListener("click", close);
    addEventListener("keydown", esc, true);
    document.body.append(background);
  }

  /// Reads what the transcript gained and adds it to the end of the conversation.
  async function readChat(chat: Chat) {
    if (chat.reading || !chat.panel.isAlive()) return;
    // The session ended: the last conversation stays on screen, it just doesn't grow anymore.
    const path = claude.panel(chat.panel.id)?.transcript ?? chat.path;
    if (!path) return;
    const other = path !== chat.path;
    chat.reading = true;
    try {
      const tr = await claude.transcript(path, other ? 0 : chat.end);
      const messages = readMessages(tr.text);
      if (other || tr.from_start) {
        chat.list.replaceChildren(chat.more);
        chat.pending = [];
        if (tr.truncated) {
          const note = element("div", "chat-note");
          note.textContent = t.startInTerminal;
          chat.list.prepend(note);
        }
        chat.messages = [];
        // Of the conversation that already existed, only the end goes on screen.
        chat.since = Math.max(0, messages.length - CHAT_WINDOW);
        chat.more.hidden = chat.since === 0;
        chat.atEnd = true;
      }
      chat.path = path;
      chat.end = tr.end;
      if (!messages.length) return;
      const first = Math.max(chat.since - chat.messages.length, 0);
      chat.messages.push(...messages);
      // Each of your turns that arrives takes the place of its provisional bubble.
      for (const f of messages) {
        if (f.who !== "you") continue;
        const n = provisionalResolved(
          chat.pending.map((p) => p.text),
          f.text,
        );
        for (const p of chat.pending.splice(0, n)) p.el.remove();
      }
      chat.list.append(...messages.slice(first).map(drawMessage));
      // Only those already at the end follow it: whoever scrolled up to reread isn't
      // pulled back on every new turn.
      if (chat.isOpen) restoreScroll(chat);
      // A resumed conversation brings prompts the hook didn't see go by.
      claude.rememberPrompts(chat.panel.id, messages.flatMap((f) => (f.who === "you" ? [f.text] : [])));
    } catch (e) {
      // Claude only creates the file on the first turn: until then, there is nothing to read.
      if (!String(e).includes("No such file")) ctx.log(`chat: ${e}`);
    } finally {
      chat.reading = false;
    }
  }

  // ---------- switching modes ----------

  /// The chat comes in or goes out over the terminal: fades with a slight slide. On the
  /// way out it only vanishes at the end, and meanwhile it doesn't hold clicks — the
  /// terminal below is already the panel.
  function transition(chat: Chat) {
    const { layer: el, isOpen } = chat;
    const meio = chat.transition?.playState === "running" ? chat.transition.currentTime : null;
    chat.transition?.cancel();
    chat.transition = undefined;
    el.style.pointerEvents = isOpen ? "" : "none";
    if (isOpen) el.hidden = false;
    if (reducedMotion.matches) {
      el.hidden = !isOpen;
      return;
    }
    const frames = [
      { opacity: 0, transform: "translateY(8px)" },
      { opacity: 1, transform: "none" },
    ];
    const anim = el.animate(isOpen ? frames : frames.reverse(), {
      duration: CHAT_DURATION,
      easing: isOpen ? "cubic-bezier(0.2, 0.7, 0.3, 1)" : "ease-in",
    });
    // Turning around midway starts from the mirrored point, without a jump.
    if (typeof meio === "number") anim.currentTime = Math.max(0, CHAT_DURATION - meio);
    chat.transition = anim;
    anim.onfinish = () => {
      if (chat.transition !== anim) return;
      chat.transition = undefined;
      if (!chat.isOpen) el.hidden = true;
    };
  }

  /// Switches the panel between the terminal and the conversation in bubbles. It is per
  /// panel: with the screen split, one may be in chat and the neighbor in the terminal.
  async function toggle(panel: Panel) {
    const id = panel.id;
    const open = chats.get(id);
    if (open?.isOpen) {
      open.isOpen = false;
      transition(open);
      open.flash = undefined;
      open.sessions = undefined;
      drawCommands(open);
      clearInterval(open.pulse);
      open.pulse = undefined;
      claude.setChatOpen(id, false);
      claude.setMessageNavigator(id, undefined);
    } else {
      // With no Claude session in the panel, the button opens one: the chat is the way to
      // start a conversation in that folder, not only to see one that already exists.
      if (!claude.panel(id)) {
        if (!(await claude.start(id))) return panel.notify(t.programRunning);
        // The repeated click while the session was starting.
        if (chats.get(id)?.isOpen) return;
      }
      const chat = chats.get(id) ?? createChat(panel);
      chats.set(id, chat);
      chat.isOpen = true;
      transition(chat);
      claude.setChatOpen(id, true);
      claude.setMessageNavigator(id, (delta) => goToMessage(chat, delta));
      void loadCommands(chat);
      // Hidden, the list lost its scroll position.
      restoreScroll(chat);
      void readChat(chat);
      chat.pulse = setInterval(() => {
        void readChat(chat);
        drawThinking(chat);
      }, CHAT_MS);
    }
    drawButton(id);
    const chat = chats.get(id);
    if (!chat) return;
    drawNotice(chat);
    // The field gets the panel's keyboard (and the paths dropped on it) while the chat
    // is on screen; closed, the terminal gets it back.
    panel.setKeyboard(chat.isOpen ? chat.campo : undefined);
  }

  function closeChat(id: number) {
    const chat = chats.get(id);
    if (!chat) return;
    clearInterval(chat.pulse);
    chat.resize.disconnect();
    chats.delete(id);
  }

  void (async () => {
    try {
      const s = await loadSettings();
      switchModeDiff(s.viewMode);
      ctx.subscriptions.push({ dispose: await onSettings(({ viewMode }) => switchModeDiff(viewMode)) });
    } catch (e) {
      ctx.log(`diff mode: ${e}`);
    }
  })();

  ctx.subscriptions.push(
    ctx.regions.panelHeader("chat", (panel, el) => {
      const b = document.createElement("button");
      b.className = "task-btn task-chat";
      b.innerHTML = ICON_CHAT;
      // The click doesn't take the keyboard from the terminal.
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => void toggle(panel));
      el.append(b);
      buttons.set(panel.id, b);
      drawButton(panel.id);
      return { dispose: () => void buttons.delete(panel.id) };
    }),
    claude.onChange((id, c: ClaudePanel | undefined) => {
      drawButton(id);
      const chat = chats.get(id);
      if (!chat) return;
      drawNotice(chat);
      // The session may have changed under an open chat (`/clear`, `/resume`),
      // and a new prompt is already in the transcript: read now, without waiting for the pulse.
      if (chat.isOpen && c) void readChat(chat);
    }),
    ctx.terminal.onClosed(closeChat),
    ctx.commands.register("toggle", () => {
      const panel = ctx.terminal.focusedPanel();
      if (panel) void toggle(panel);
    }),
  );

  return () => {
    for (const id of [...chats.keys()]) {
      claude.setChatOpen(id, false);
      claude.setMessageNavigator(id, undefined);
      closeChat(id);
    }
    buttons.clear();
  };
}


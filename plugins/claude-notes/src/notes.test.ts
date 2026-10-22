import { describe, expect, it } from "vitest";
import { addByHand, addComment, apply, replyMessage, counts, markRead, newTask, removeNote, setStatus, taskKey, taskName, toMarkdown, type Task } from "./notes";

const place = { folder: "/repo/app", repo: "/repo", branch: "FMN-10610" };
const empty = (): Task => newTask(place, 1);
const send = (task: Task, message: unknown) => apply(task, JSON.stringify(message), "s1", 2);

describe("taskKey", () => {
  it("is the repository and branch, or the folder outside a repository", () => {
    expect(taskKey(place)).toBe("/repo\0FMN-10610");
    expect(taskKey({ folder: "/tmp", repo: null, branch: null })).toBe("/tmp\0");
    expect(taskKey({ folder: null, repo: null, branch: null })).toBeUndefined();
  });

  it("names the task by folder and branch", () => {
    expect(taskName(empty())).toBe("repo · FMN-10610");
  });
});

describe("apply", () => {
  it("records items with ids per kind, starting at each kind's first status", () => {
    let t = send(empty(), { kind: "decision", title: "Sem min, sem validação", body: "Por quê: …" });
    expect(t.answer).toBe("recorded D1");
    t = send(t.task, { kind: "question", title: "O PO aceita?" });
    expect(t.answer).toBe("recorded Q1");
    t = send(t.task, { kind: "decision", title: "90 dias" });
    expect(t.answer).toBe("recorded D2");
    expect(t.task.notes.map((n) => [n.id, n.status, n.session])).toEqual([
      ["D1", "pending", "s1"],
      ["Q1", "open", "s1"],
      ["D2", "pending", "s1"],
    ]);
  });

  it("never reuses a deleted id", () => {
    const t = send(empty(), { kind: "finding", title: "x" }).task;
    expect(send(removeNote(t, "F1", 3), { kind: "finding", title: "y" }).answer).toBe("recorded F2");
  });

  it("updates status and keeps the history", () => {
    const t = send(empty(), { kind: "question", title: "?" }).task;
    const u = send(t, { update: "q1", status: "answered", note: "PO: sim" });
    expect(u.answer).toBe("updated Q1");
    expect(u.task.notes[0].status).toBe("answered");
    expect(u.task.notes[0].history).toEqual([{ at: 2, status: "answered", note: "PO: sim", by: "claude" }]);
  });

  it("forgives real line breaks inside a string", () => {
    const r = apply(empty(), '{"kind":"decision","title":"x","body":"line one\n- item\tand \\"quoted\\""}', "s1", 2);
    expect(r.answer).toBe("recorded D1");
    expect(r.task.notes[0].body).toBe('line one\n- item\tand "quoted"');
  });

  it("explains what is wrong, for Claude to fix", () => {
    expect(apply(empty(), "nope", undefined, 1).answer).toMatch(/^error: the message must be JSON/);
    expect(send(empty(), { kind: "idea", title: "x" }).answer).toMatch(/^error: "kind" is one of/);
    expect(send(empty(), { kind: "decision" }).answer).toMatch(/^error: "title" is missing/);
    expect(send(empty(), { update: "D9", status: "ratified" }).answer).toMatch(/^error: no item D9/);
    const t = send(empty(), { kind: "decision", title: "x" }).task;
    expect(send(t, { update: "D1", status: "answered" }).answer).toMatch(/^error: the status of a decision/);
    expect(send(t, { update: "D1" }).answer).toMatch(/^error: an update needs/);
  });

  it("lists the notebook as Markdown, without changing it", () => {
    const t = send(empty(), { kind: "decision", title: "90 dias", body: "Por quê: bater com o calendário." }).task;
    const r = send(t, { list: true });
    expect(r.changed).toBe(false);
    expect(r.answer).toBe("# repo · FMN-10610\n\n## Decisions\n\n### D1 - 90 dias [pending]\n\nPor quê: bater com o calendário.");
  });
});

describe("milestones and reports", () => {
  it("keeps subtasks in their milestone, by hand or from Claude, and checks them off without history", () => {
    let t = addByHand(empty(), "milestone", "  Goldens ", 3);
    t = addByHand(t, "todo", "  Rodar os goldens ", 3, "M1");
    t = send(t, { kind: "todo", milestone: "m1", title: "Atualizar o arb" }).task;
    expect(t.notes.map((n) => [n.id, n.title, n.status, n.milestone])).toEqual([
      ["M1", "Goldens", "active", undefined],
      ["T1", "Rodar os goldens", "todo", "M1"],
      ["T2", "Atualizar o arb", "todo", "M1"],
    ]);
    t = setStatus(t, "T1", "done", 4);
    expect(t.notes[1]).toMatchObject({ status: "done", history: [] });
    expect(send(t, { update: "T2", status: "done" }).answer).toBe("updated T2");
    expect(send(t, { update: "M1", status: "done" }).answer).toBe("updated M1");
  });

  it("refuses a subtask in a milestone that doesn't exist, and a milestone in a milestone", () => {
    expect(send(empty(), { kind: "todo", milestone: "M3", title: "x" }).answer).toMatch(/^error: no milestone M3/);
    const t = send(empty(), { kind: "milestone", title: "a" }).task;
    expect(send(t, { kind: "decision", milestone: "M1", title: "x" }).answer).toMatch(/^error: only a todo/);
  });

  it("moves a subtask between milestones, and out of one", () => {
    let t = send(empty(), { kind: "milestone", title: "a" }).task;
    t = send(t, { kind: "milestone", title: "b" }).task;
    t = send(t, { kind: "todo", milestone: "M1", title: "x" }).task;
    t = send(t, { update: "T1", milestone: "M2" }).task;
    expect(t.notes[2].milestone).toBe("M2");
    expect(send(t, { update: "T1", milestone: "" }).task.notes[2].milestone).toBeUndefined();
  });

  it("leaves a deleted milestone's subtasks without one", () => {
    let t = send(empty(), { kind: "milestone", title: "a" }).task;
    t = send(t, { kind: "todo", milestone: "M1", title: "x" }).task;
    expect(removeNote(t, "M1", 5).notes).toMatchObject([{ id: "T1", milestone: undefined }]);
  });

  it("marks new reports read, once", () => {
    const t = send(empty(), { kind: "report", title: "Feito", body: "- a\n- b" }).task;
    expect(t.notes[0].status).toBe("new");
    const read = markRead(t, 5);
    expect(read.notes[0].status).toBe("read");
    expect(markRead(read, 6)).toBe(read);
  });
});

describe("replies", () => {
  it("keeps what you wrote and frames it for Claude", () => {
    const t = send(empty(), { kind: "decision", title: "90 dias" }).task;
    expect(addComment(t, "D1", " prefiro 3 meses ", 7).notes[0].history).toEqual([{ at: 7, note: "prefiro 3 meses", by: "you" }]);
    expect(replyMessage(t.notes[0], "prefiro 3 meses")).toBe(
      'About notebook item D1 (decision, pending): "90 dias"\n\nprefiro 3 meses\n\nWhen it is settled, update D1 in the notebook.',
    );
  });
});

describe("by hand", () => {
  it("changes the status and counts what is pending", () => {
    let t = send(empty(), { kind: "decision", title: "a" }).task;
    t = send(t, { kind: "question", title: "b" }).task;
    expect(counts(t)).toEqual({ milestone: 0, todo: 0, decision: 1, question: 1, finding: 0, report: 0, pending: 2 });
    t = setStatus(t, "D1", "ratified", 5);
    expect(counts(t)).toMatchObject({ decision: 0, pending: 1 });
    expect(t.notes[0].history[t.notes[0].history.length - 1]).toEqual({ at: 5, status: "ratified", by: "you" });
    expect(toMarkdown(t)).toContain("- User: → ratified");
  });
});

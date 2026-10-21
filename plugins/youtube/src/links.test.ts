import { describe, expect, it } from "vitest";
import { linkOf, parseLink } from "./links";

describe("parseLink", () => {
  it("reads every kind of video link", () => {
    const video = { kind: "video", id: "jfKfPfyJRdk" };
    expect(parseLink("jfKfPfyJRdk")).toEqual(video);
    expect(parseLink("https://www.youtube.com/watch?v=jfKfPfyJRdk")).toEqual(video);
    expect(parseLink("youtube.com/watch?v=jfKfPfyJRdk&t=30s")).toEqual(video);
    expect(parseLink("https://youtu.be/jfKfPfyJRdk?si=abc")).toEqual(video);
    expect(parseLink("https://www.youtube.com/live/jfKfPfyJRdk?feature=share")).toEqual(video);
    expect(parseLink("https://www.youtube.com/embed/jfKfPfyJRdk")).toEqual(video);
    expect(parseLink("https://m.youtube.com/shorts/jfKfPfyJRdk")).toEqual(video);
    expect(parseLink("https://music.youtube.com/watch?v=jfKfPfyJRdk")).toEqual(video);
  });

  it("takes the playlist when the link has one", () => {
    const playlist = { kind: "playlist", id: "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI" };
    expect(parseLink("https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI")).toEqual(playlist);
    expect(parseLink("https://www.youtube.com/watch?v=jfKfPfyJRdk&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI")).toEqual(playlist);
    expect(parseLink("PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI")).toEqual(playlist);
  });

  it("plays a mix's video alone: mixes don't load as playlists", () => {
    expect(parseLink("https://www.youtube.com/watch?v=jfKfPfyJRdk&list=RDjfKfPfyJRdk")).toEqual({ kind: "video", id: "jfKfPfyJRdk" });
  });

  it("refuses what isn't YouTube", () => {
    expect(parseLink("")).toBeUndefined();
    expect(parseLink("hello world")).toBeUndefined();
    expect(parseLink("https://vimeo.com/watch?v=jfKfPfyJRdk")).toBeUndefined();
    expect(parseLink("https://www.youtube.com/@LofiGirl")).toBeUndefined();
  });

  it("builds the link oEmbed is asked about", () => {
    expect(linkOf({ kind: "video", id: "jfKfPfyJRdk" })).toBe("https://www.youtube.com/watch?v=jfKfPfyJRdk");
    expect(linkOf({ kind: "playlist", id: "PL123" })).toBe("https://www.youtube.com/playlist?list=PL123");
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { LaneQueue } from "../src/runtime/lane-queue.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("LaneQueue serializes work inside a single lane", async () => {
  const queue = new LaneQueue({ maxDepth: 20 });
  const order = [];

  const first = queue.enqueue("lane:a", async () => {
    order.push("first:start");
    await sleep(30);
    order.push("first:end");
    return 1;
  });

  const second = queue.enqueue("lane:a", async () => {
    order.push("second:start");
    await sleep(5);
    order.push("second:end");
    return 2;
  });

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, 1);
  assert.equal(b, 2);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("LaneQueue allows parallel work across different lanes", async () => {
  const queue = new LaneQueue({ maxDepth: 20 });
  const marks = [];

  const laneA = queue.enqueue("lane:a", async () => {
    marks.push("a:start");
    await sleep(40);
    marks.push("a:end");
  });

  const laneB = queue.enqueue("lane:b", async () => {
    marks.push("b:start");
    await sleep(10);
    marks.push("b:end");
  });

  await Promise.all([laneA, laneB]);
  const aStart = marks.indexOf("a:start");
  const bStart = marks.indexOf("b:start");
  const aEnd = marks.indexOf("a:end");
  const bEnd = marks.indexOf("b:end");

  assert.notEqual(aStart, -1);
  assert.notEqual(bStart, -1);
  assert.notEqual(aEnd, -1);
  assert.notEqual(bEnd, -1);
  assert.ok(bStart < aEnd, "lane:b should start before lane:a ends");
});

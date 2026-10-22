import { expect, test } from "vitest";
import { ApiError } from "./api";

test("shows a clear message for a blocked article review", () => {
  const error = new ApiError(422, "ARTICLE_CHECK_FAILED");
  expect(error.message).toBe("文章还有未完成内容或无效图片，请修改后再定稿");
});

test("keeps unknown server error codes visible for troubleshooting", () => {
  expect(new ApiError(500, "UNKNOWN_ERROR").message).toBe("UNKNOWN_ERROR");
});

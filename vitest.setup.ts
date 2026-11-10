// テストは日本語で走らせる。既存のテストは日本語の文言を見ているので、
// 言語を固定して、実行する機械の言語設定で結果が変わらないようにする。
import { setLocaleForTest } from "@/lib/i18n";

setLocaleForTest("ja");

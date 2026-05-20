import { redirect } from "next/navigation";

/** @deprecated Use `/login`. Kept for bookmarks and old OAuth redirect URLs. */
export default function ConnectRedirectPage() {
  redirect("/login");
}

import { facebookShareUrl } from "@/lib/share/social";
import { buttonClasses } from "@/components/ui";

/** "Share on Facebook" link for a trip that outsiders can open. Opens Facebook's own share dialog in a new tab. */
export function ShareButtons({ url, size = "sm" }: { url: string; size?: "sm" | "md" }) {
  return (
    <a
      href={facebookShareUrl(url)}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonClasses("secondary", size)}
      aria-label="Share on Facebook"
      data-testid="share-facebook"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="#1877F2">
        <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07c0 6.02 4.39 11.02 10.13 11.93v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.88v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.09 24 12.07z" />
      </svg>
      Share on Facebook
    </a>
  );
}

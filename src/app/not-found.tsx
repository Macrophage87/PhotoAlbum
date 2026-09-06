import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex-1 flex items-center justify-center p-10 text-center">
      <div>
        <h1 className="font-display text-3xl font-semibold">Not found</h1>
        <p className="text-muted mt-2">That page doesn&apos;t exist, or you don&apos;t have access to it.</p>
        <Link href="/" className="inline-block mt-4 text-primary underline-offset-2 hover:underline">
          Back to trips
        </Link>
      </div>
    </div>
  );
}

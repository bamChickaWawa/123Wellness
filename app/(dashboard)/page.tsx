import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArrowRight, HeartPulse } from 'lucide-react';

export default function HomePage() {
  return (
    <main>
      <section className="py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <div className="flex justify-center mb-6">
            <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-orange-500 text-white">
              <HeartPulse className="h-7 w-7" />
            </div>
          </div>
          <h1 className="text-4xl font-bold text-gray-900 tracking-tight sm:text-5xl">
            1-2-3 Wellness
          </h1>
          <p className="mt-4 text-lg text-gray-500 max-w-2xl mx-auto">
            A simple daily check-in for students, with a class view for teachers.
            Students share how they’re feeling; educators see trends and who
            might need a little extra support.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Button
              asChild
              size="lg"
              className="rounded-full bg-orange-500 hover:bg-orange-600 text-white"
            >
              <Link href="/sign-in">
                Sign in
                <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="rounded-full">
              <Link href="/sign-up">Create account</Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

"use client";

import { ArrowRight, HardHat, LineChart } from "lucide-react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const choose = (role: "worker" | "manager") => {
    localStorage.setItem("plant-copilot-role", role);
    router.push(`/${role}`);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl items-center px-6 py-16">
      <div className="w-full">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.24em] text-moss">AI Plant Memory</p>
        <h1 className="max-w-4xl text-5xl font-black tracking-tight sm:text-7xl">
          Turn yesterday&apos;s fixes into today&apos;s first checks.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">
          Evidence-grounded breakdown triage, captured resolutions, and a live reliability view for the whole plant.
        </p>
        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <button onClick={() => choose("worker")} className="card group p-8 text-left transition hover:-translate-y-1">
            <HardHat className="mb-8 h-12 w-12 text-moss" />
            <span className="block text-3xl font-black">I&apos;m a Worker</span>
            <span className="mt-3 block text-slate-600">Describe a breakdown, see cited checks, and log the final fix.</span>
            <ArrowRight className="mt-8 transition group-hover:translate-x-2" />
          </button>
          <button onClick={() => choose("manager")} className="card group p-8 text-left transition hover:-translate-y-1">
            <LineChart className="mb-8 h-12 w-12 text-amber" />
            <span className="block text-3xl font-black">I&apos;m a Manager</span>
            <span className="mt-3 block text-slate-600">Track open work, repeat failures, downtime, and recent RCAs.</span>
            <ArrowRight className="mt-8 transition group-hover:translate-x-2" />
          </button>
        </div>
      </div>
    </main>
  );
}

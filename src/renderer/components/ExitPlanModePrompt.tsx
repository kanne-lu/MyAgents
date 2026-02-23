import { FileCheck, X, Check, Terminal, CheckCircle, XCircle } from 'lucide-react';
import Markdown from '@/components/Markdown';

import type { ExitPlanModeRequest } from '../../shared/types/planMode';

interface ExitPlanModePromptProps {
    request: ExitPlanModeRequest;
    onApprove: () => void;
    onReject: () => void;
}

/**
 * ExitPlanMode prompt - AI submits a plan for user review
 */
export function ExitPlanModePrompt({ request, onApprove, onReject }: ExitPlanModePromptProps) {
    const isResolved = !!request.resolved;
    const isApproved = request.resolved === 'approved';

    return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className={`rounded-xl border p-4 shadow-sm ${
                isResolved && !isApproved
                    ? 'border-gray-200 bg-gray-50/80 dark:border-gray-700 dark:bg-gray-900/40'
                    : 'border-green-200 bg-green-50/80 dark:border-green-800 dark:bg-green-950/40'
            }`}>
                {/* Header */}
                <div className={`${isResolved ? '' : 'mb-3'} flex items-center gap-2`}>
                    <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                        isResolved && !isApproved
                            ? 'bg-gray-100 dark:bg-gray-800'
                            : 'bg-green-100 dark:bg-green-900/50'
                    }`}>
                        <FileCheck className={`h-4.5 w-4.5 ${
                            isResolved && !isApproved
                                ? 'text-gray-500 dark:text-gray-400'
                                : 'text-green-600 dark:text-green-400'
                        }`} />
                    </div>
                    <div className="flex-1">
                        <h3 className={`text-sm font-semibold ${
                            isResolved && !isApproved
                                ? 'text-gray-700 dark:text-gray-300'
                                : 'text-green-900 dark:text-green-100'
                        }`}>方案审核</h3>
                        <p className={`text-xs ${
                            isResolved && !isApproved
                                ? 'text-gray-500 dark:text-gray-400'
                                : 'text-green-600 dark:text-green-400'
                        }`}>AI 完成了方案设计，请审核后决定是否执行</p>
                    </div>
                    {/* Resolved badge in header */}
                    {isResolved && (
                        <div className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                            isApproved
                                ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
                                : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                        }`}>
                            {isApproved
                                ? <><CheckCircle className="h-3.5 w-3.5" />已批准</>
                                : <><XCircle className="h-3.5 w-3.5" />已拒绝</>
                            }
                        </div>
                    )}
                </div>

                {/* Plan content — always visible */}
                {request.plan && (
                    <div className={`mt-3 max-h-[26rem] overflow-y-auto rounded-lg border p-3 text-sm ${
                        isResolved && !isApproved
                            ? 'border-gray-200 bg-gray-50/60 dark:border-gray-700 dark:bg-gray-900/40'
                            : 'border-green-200 bg-white/80 dark:border-green-800 dark:bg-gray-900/60'
                    }`}>
                        <Markdown>{request.plan}</Markdown>
                    </div>
                )}

                {/* Allowed prompts — always visible */}
                {request.allowedPrompts && request.allowedPrompts.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                        <p className={`text-xs font-medium ${
                            isResolved && !isApproved
                                ? 'text-gray-500 dark:text-gray-400'
                                : 'text-green-700 dark:text-green-300'
                        }`}>需要的权限：</p>
                        {request.allowedPrompts.map((ap, i) => (
                            <div key={i} className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs ${
                                isResolved && !isApproved
                                    ? 'bg-gray-100/60 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400'
                                    : 'bg-green-100/60 text-green-800 dark:bg-green-900/30 dark:text-green-200'
                            }`}>
                                <Terminal className="h-3.5 w-3.5 shrink-0" />
                                <span>{ap.prompt}</span>
                            </div>
                        ))}
                    </div>
                )}

                {/* Actions - only show when not resolved */}
                {!isResolved && (
                    <div className="mt-3 flex justify-end gap-2">
                        <button
                            onClick={onReject}
                            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                        >
                            <X className="h-3.5 w-3.5" />
                            拒绝
                        </button>
                        <button
                            onClick={onApprove}
                            className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600"
                        >
                            <Check className="h-3.5 w-3.5" />
                            批准执行
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

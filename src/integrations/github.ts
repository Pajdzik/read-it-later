import type { Env, IntegrationConfiguration, IntegrationStatus } from '../contracts';
import { getGitHubBackupConfiguration, getGitHubBackupStatus, saveGitHubBackup } from '../articles/github';
import type { ArticleIntegration } from './types';

export function githubIntegration(env: Env): ArticleIntegration | null {
  const target = getGitHubBackupConfiguration(env);
  if (!target.configured || !target.repository || !target.branch || target.folder === undefined || !target.destinationKey) return null;
  const configuration: IntegrationConfiguration = {
    id: 'github', name: 'GitHub', configured: true,
    description: 'Save Markdown files to a repository. Files inherit the repository’s visibility.',
    destination: `${target.repository} · ${target.branch} · ${target.folder || '(repository root)'}`,
    destinationKey: target.destinationKey,
  };
  return {
    configuration,
    async status(article, copy): Promise<IntegrationStatus> { return getGitHubBackupStatus(env, article, copy); },
    async deliver({ article, copy }) {
      return saveGitHubBackup(env, article.id, copy.revision, {
        repository: target.repository!, branch: target.branch!, folder: target.folder!,
      });
    },
  };
}

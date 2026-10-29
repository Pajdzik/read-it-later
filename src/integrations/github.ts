import type { Env, GitHubBackupStatus, IntegrationStatus } from '../contracts';
import { getGitHubBackupConfiguration, getGitHubBackupStatus, saveGitHubBackup } from '../articles/github';
import type { ArticleIntegration } from './types';

/** Keep existing path reservations, conflict protection and confirmed backups. */
export function githubIntegration(env: Env): ArticleIntegration | null {
  const target = getGitHubBackupConfiguration(env);
  if (!target.configured) return null;
  const configuration = {
    id: 'github', name: 'GitHub', configured: true,
    description: 'Save Markdown files to a repository. Files inherit the repository’s visibility.',
    destination: `${target.repository} · ${target.branch} · ${target.folder || '(repository root)'}`,
    destinationKey: JSON.stringify([target.repository, target.branch, target.folder]),
  };
  const status = (backup: GitHubBackupStatus): IntegrationStatus => ({
    ...configuration, state: backup.state ?? 'not_saved',
    ...(backup.backedUpAt ? { deliveredAt: backup.backedUpAt } : {}),
    ...(backup.url ? { url: backup.url } : {}),
  });
  return {
    configuration,
    async status(article, copy) { return status(await getGitHubBackupStatus(env, article, copy)); },
    async deliver({ article, copy }) {
      const result = await saveGitHubBackup(env, article.id, copy.revision, {
        repository: target.repository!, branch: target.branch!, folder: target.folder!,
      });
      return { integration: status(result.backup), unchanged: result.unchanged };
    },
  };
}

import styles from './Skeleton.module.css'

type SessionSkeletonProps = {
  label: string
}

export const SessionSkeleton = ({ label }: SessionSkeletonProps) => (
  <div className={styles.wrap} role="status" aria-live="polite" aria-label={label}>
    <div className={styles.userRow}>
      <div className={styles.userBubble} />
    </div>
    <div className={styles.assistantBlock}>
      <div className={styles.line} style={{ width: '78%' }} />
      <div className={styles.line} style={{ width: '92%' }} />
      <div className={styles.line} style={{ width: '64%' }} />
    </div>
    <div className={styles.userRow}>
      <div className={styles.userBubbleShort} />
    </div>
    <div className={styles.assistantBlock}>
      <div className={styles.line} style={{ width: '85%' }} />
      <div className={styles.line} style={{ width: '56%' }} />
    </div>
  </div>
)

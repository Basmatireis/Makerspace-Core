import { UserAvatar } from '@carbon/icons-react';
import type { Person } from '../../api/generated/models';

type PersonAvatarProps = {
  firstName: string;
  lastName: string;
  profileImage?: Person['profileImage'];
  size?: 'sm' | 'md' | 'lg';
  decorative?: boolean;
};

export function PersonAvatar({
  firstName,
  lastName,
  profileImage,
  size = 'md',
  decorative = false,
}: PersonAvatarProps) {
  const name = `${firstName} ${lastName}`;
  const className = `person-avatar person-avatar--${size}`;

  if (profileImage) {
    return (
      <img
        className={className}
        src={profileImage.downloadUrl}
        alt={decorative ? '' : `${name} profile`}
      />
    );
  }

  return (
    <span
      className={`${className} person-avatar--fallback`}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : `${name} has no profile image`}
      role={decorative ? undefined : 'img'}
    >
      <UserAvatar />
    </span>
  );
}

package roles

import "github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"

// Membership is the membership system role a person holds exactly one of. Who staffs open days, and in which kind of
// place, is derived from it and never from role names.
type Membership string

const (
	MembershipSupervisor Membership = "supervisor"
	MembershipTrainee    Membership = "trainee"
	MembershipVisitor    Membership = "visitor"
)

// Valid reports whether the membership is one of the known memberships.
func (m Membership) Valid() bool {
	return m == MembershipSupervisor || m == MembershipTrainee || m == MembershipVisitor
}

// SystemKey is the system key of the membership's role.
func (m Membership) SystemKey() authorization.SystemKey { return authorization.SystemKey(m) }

// Staffs reports whether people with the membership staff open days.
func (m Membership) Staffs() bool { return m == MembershipSupervisor || m == MembershipTrainee }

// MembershipOf returns the membership a system key names, or false for master and custom roles.
func MembershipOf(key *authorization.SystemKey) (Membership, bool) {
	if key == nil || !key.IsMembership() {
		return "", false
	}
	return Membership(*key), true
}

// membershipRoleProtectedCode answers attempts to rename or delete a membership role.
const membershipRoleProtectedCode = "membership_role_protected"

// Community links shown in the Community modal
// Add more entries here (Zalo, Discord, YouTube, ...) without touching UI code.
export interface CommunityLink {
  id: string;
  label: string;
  description: string;
  url: string;
  icon: string;
  color: string;
}

export const COMMUNITY_LINKS: CommunityLink[] = [
  {
    id: "facebook",
    label: "Facebook Group",
    description: "Report bugs & suggest features to 9Team community",
    url: "https://www.facebook.com/groups/9teamvn",
    icon: "Facebook",
    color: "#1877F2",
  },
  {
    id: "github",
    label: "GitHub",
    description: "Source code & issue tracker",
    url: "https://github.com/decolua/9remote",
    icon: "Github",
    color: "#ffffff",
  },
];

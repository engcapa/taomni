#include <cstddef>
#include <string>
#include <vector>

#include <librevenge/librevenge.h>
#include <librevenge-stream/librevenge-stream.h>
#include <libvisio/libvisio.h>
#include <unicode/udata.h>

namespace {

constexpr unsigned max_pages = 128;
constexpr std::size_t max_output = 32 * 1024 * 1024;

librevenge::RVNGStringVector pages;
std::vector<std::string> names;

class PageLimitExceeded {};

class DrawingGenerator final : public librevenge::RVNGSVGDrawingGenerator {
public:
  DrawingGenerator() : RVNGSVGDrawingGenerator(pages, "") {}

  void startPage(const librevenge::RVNGPropertyList &properties) override {
    if (names.size() == max_pages) {
      exceeded = true;
      throw PageLimitExceeded();
    }
    const auto *name = properties["draw:name"];
    names.emplace_back(name ? name->getStr().cstr() : "");
    RVNGSVGDrawingGenerator::startPage(properties);
  }

  void endPage() override {
    RVNGSVGDrawingGenerator::endPage();
    size += pages[pages.size() - 1].size();
    if (size > max_output) {
      exceeded = true;
      throw PageLimitExceeded();
    }
  }

  bool exceeded = false;

private:
  std::size_t size = 0;
};

}

extern "C" int visio_init_icu(const void *data) {
  UErrorCode status = U_ZERO_ERROR;
  udata_setCommonData(data, &status);
  return U_FAILURE(status);
}

extern "C" int visio_decode(const unsigned char *bytes, unsigned size, bool stencils) {
  librevenge::RVNGStringStream input(bytes, size);
  if (!libvisio::VisioDocument::isSupported(&input)) return 1;

  DrawingGenerator drawing;
  bool parsed = false;
  try {
    parsed = stencils ? libvisio::VisioDocument::parseStencils(&input, &drawing)
                      : libvisio::VisioDocument::parse(&input, &drawing);
  } catch (const PageLimitExceeded &) {
    return 3;
  }
  if (drawing.exceeded) return 3;
  return !parsed || pages.empty() ? 2 : 0;
}

extern "C" unsigned visio_page_count() {
  return pages.size();
}

extern "C" const char *visio_page_svg(unsigned position) {
  return position < pages.size() ? pages[position].cstr() : nullptr;
}

extern "C" const char *visio_page_name(unsigned position) {
  return position < names.size() ? names[position].c_str() : nullptr;
}
